// Voice capture: audio -> transcript -> structured draft for the review sheet.
//
// Orchestration only. Transcription lives in llm/transcribe.ts, the language
// work in llm/parseTaskDraft.ts, and the calendar math in domain/voiceWhen.ts.
// Nothing here writes to the database — the review sheet hands the draft back
// to the ordinary createTask path once the user confirms, so auto-categorise,
// XP scoring, event-log append and household rules all behave exactly as they
// do for a typed task.
import type { Recurrence } from '../../domain/recurrence'
import { resolveVoiceWhen, type VoiceWhen } from '../../domain/voiceWhen'
import type { VoiceAssignee } from '../llm/parseTaskDraft'
import { parseTaskDraft } from '../llm/parseTaskDraft'
import { isWhisperConfigured, transcribeAudio } from '../llm/transcribe'
import { getMyHousehold, type MyHousehold } from './households'
import { getUserTimeZone } from './tasks'

/** Base64 of ~8MB of audio, plus slack for the encoding overhead. */
const MAX_BASE64_LENGTH = 12 * 1024 * 1024

export type VoiceCaptureStatus =
  /** Transcribed and parsed; `draft` is fully populated. */
  | 'ok'
  /** Transcribed, but the parse failed; `draft` holds the raw transcript. */
  | 'parse_failed'
  /** Nothing audible — silence, or only a known Whisper artifact. */
  | 'no_speech'
  /** Whisper isn't configured or couldn't be reached. */
  | 'unavailable'

/** A draft in the shape the review sheet edits and createTask consumes. */
export interface VoiceDraft {
  title: string
  notes: string | null
  recurrence: Recurrence | null
  timeOfDay: string | null
  dueAtOverride: string | null
  someday: boolean
  /** Set when the task belongs to the household rather than the speaker. */
  householdId: string | null
  /** Null with a householdId means free-for-all. */
  assignedToUserId: string | null
  assigneeGroup: 'adults' | 'kids' | null
}

/** Only adults may own or be assigned chores; kids cannot create at all. */
function isAdult(role: string): boolean {
  return role === 'admin' || role === 'member'
}

/**
 * Match a spoken name to a household member.
 *
 * The model is told to return a name from the roster, but names are a closed
 * vocabulary, so this settles it deterministically rather than trusting that
 * — the same reasoning as the weekday reconciliation in parseTaskDraft.
 * Matches on full name, first name, or handle, case-insensitively. An
 * ambiguous or unknown name resolves to null and falls back to the default,
 * so a misheard name never silently assigns someone else's chore.
 */
export function resolveMemberName(
  name: string,
  members: Array<{ userId: string; name: string; handle: string }>,
): string | null {
  const needle = name.trim().toLowerCase()
  if (!needle) return null

  const candidates = members.filter((m) => {
    const full = m.name.trim().toLowerCase()
    return full === needle || full.split(/\s+/)[0] === needle || m.handle.toLowerCase() === needle
  })
  return candidates.length === 1 ? candidates[0].userId : null
}

/**
 * Turn the spoken assignment into household fields.
 *
 * With no household, or for a non-adult, everything collapses to a personal
 * task. Otherwise the default is a household chore assigned to the speaker.
 */
export function resolveAssignment(
  assignee: VoiceAssignee,
  household: MyHousehold | null,
): Pick<VoiceDraft, 'householdId' | 'assignedToUserId' | 'assigneeGroup'> {
  const personal = { householdId: null, assignedToUserId: null, assigneeGroup: null }
  if (!household || !isAdult(household.role)) return personal

  const householdId = household.household.id
  const mine = { householdId, assignedToUserId: household.viewerUserId, assigneeGroup: null }

  switch (assignee.kind) {
    case 'group':
      return { householdId, assignedToUserId: null, assigneeGroup: assignee.group }
    case 'person': {
      const userId = resolveMemberName(assignee.name, household.members)
      // An unmatched name is not an assignment — fall back to the speaker
      // rather than guessing at a member.
      return userId ? { householdId, assignedToUserId: userId, assigneeGroup: null } : mine
    }
    default:
      return mine
  }
}

export interface VoiceCaptureResult {
  status: VoiceCaptureStatus
  transcript: string | null
  draft: VoiceDraft | null
  /** Why a non-'ok' status happened, for the console and for error copy. */
  detail?: string | null
}

export interface CaptureVoiceTaskInput {
  /** Base64-encoded audio. The recorder sends 16kHz mono WAV. */
  audioBase64: string
  mimeType?: string
}

/**
 * Build the review-sheet draft from a parsed utterance.
 *
 * A when-clause the resolver rejects degrades to no due date rather than
 * throwing — the user still gets their title and can pick a date by hand,
 * which is strictly better than losing the capture to a confused model.
 */
export function toVoiceDraft(
  parsed: {
    title: string
    notes: string | null
    when: VoiceWhen
    recurrence: Recurrence | null
    assignee: VoiceAssignee
  },
  now: Date,
  timeZone: string,
  household: MyHousehold | null = null,
): VoiceDraft {
  let dueAtOverride: string | null = null
  let timeOfDay: string | null = null
  try {
    const resolved = resolveVoiceWhen(parsed.when, now, timeZone)
    dueAtOverride = resolved.dueAtOverride
    timeOfDay = resolved.timeOfDay
  } catch (err) {
    console.error('[voice] unresolvable when-clause:', err)
  }

  return {
    title: parsed.title,
    notes: parsed.notes,
    recurrence: parsed.recurrence,
    timeOfDay,
    dueAtOverride,
    // A recurring task with no spoken start still gets a first occurrence
    // from createTask's firstDueAt, so it is not a someday task.
    someday: dueAtOverride === null && parsed.recurrence === null,
    ...resolveAssignment(parsed.assignee, household),
  }
}

export async function captureFromAudio(
  userId: string,
  input: CaptureVoiceTaskInput,
): Promise<VoiceCaptureResult> {
  if (!isWhisperConfigured()) {
    return { status: 'unavailable', transcript: null, draft: null, detail: 'not configured' }
  }
  const base64 = input.audioBase64?.trim()
  if (!base64) return { status: 'no_speech', transcript: null, draft: null, detail: 'no audio' }
  if (base64.length > MAX_BASE64_LENGTH) {
    throw new Error('Recording is too long. Keep it under about thirty seconds.')
  }

  const audio = new Uint8Array(Buffer.from(base64, 'base64'))

  const { text: transcript, errorMessage } = await transcribeAudio({
    audio,
    mimeType: input.mimeType,
    userId,
  })
  if (!transcript) {
    // Prompts, responses and timings for every call are already in
    // llm_call_log (/admin/llm); this is the one line that explains a
    // capture the user saw fail.
    console.warn(`[voice] no speech in ${audio.byteLength}B: ${errorMessage ?? 'unknown'}`)
    return { status: 'no_speech', transcript: null, draft: null, detail: errorMessage }
  }

  const [timeZone, household] = await Promise.all([getUserTimeZone(userId), getMyHousehold(userId)])
  const now = new Date()
  const parsed = await parseTaskDraft({
    transcript,
    timeZone,
    now,
    userId,
    memberNames: household?.members.map((m) => m.name) ?? [],
  })

  if (!parsed) {
    console.warn(`[voice] parse failed for: ${JSON.stringify(transcript)}`)
    // The capture still succeeded; let the user fix it up by hand rather
    // than discarding what they said.
    return {
      status: 'parse_failed',
      transcript,
      draft: {
        title: transcript,
        notes: null,
        recurrence: null,
        timeOfDay: null,
        dueAtOverride: null,
        someday: true,
        ...resolveAssignment({ kind: 'default' }, household),
      },
    }
  }

  return { status: 'ok', transcript, draft: toVoiceDraft(parsed, now, timeZone, household) }
}
