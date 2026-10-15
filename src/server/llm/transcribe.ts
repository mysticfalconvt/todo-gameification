// Audio -> text via an OpenAI-compatible transcription endpoint.
//
// Points at whisper.cpp's whisper-server (see docs/speech-to-text.md), which
// implements POST /v1/audio/transcriptions natively. Deliberately mirrors
// client.ts: env-gated, graceful null on every failure, and every call logged
// to `llm_call_log` so transcripts show up in /admin/llm next to the parses
// they feed. There is no model env var — whisper.cpp serves one resident
// model and ignores the `model` field.
import { logLlmCall } from './client'

/** Whisper reports its own model name nowhere; label the log rows. */
const MODEL_LABEL = 'whisper.cpp'

const MAX_AUDIO_BYTES = 8 * 1024 * 1024

export function isWhisperConfigured(): boolean {
  return Boolean(process.env.WHISPER_BASE_URL)
}

// Whisper emits these for silence or non-speech noise, with high confidence
// and a useless no_speech_prob (measured at 7.9e-11 for pure silence — the
// same order as real speech, so it cannot be thresholded). A short closed
// list of the known artifacts is the only reliable server-side defence; the
// client's level gate is the primary one.
const HALLUCINATION_PHRASES = [
  'thank you',
  'thanks for watching',
  'you',
  'bye',
  'okay',
  'so',
  'oh',
  'subtitles by the amara.org community',
  'transcription by castingwords',
]

// Lowercase, strip punctuation and symbols, collapse whitespace. Applied to
// both the blocklist and the candidate so entries containing punctuation
// ("amara.org") still match once it has been stripped from the transcript.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const HALLUCINATIONS = new Set(HALLUCINATION_PHRASES.map(normalize))

/** True when a transcript is almost certainly Whisper filling in silence. */
export function isLikelyHallucination(text: string): boolean {
  const normalized = normalize(text)
  if (!normalized) return true
  return HALLUCINATIONS.has(normalized)
}

export interface TranscribeInput {
  audio: Uint8Array
  /** Content type of `audio`; the recorder sends 16kHz mono WAV. */
  mimeType?: string
  timeoutMs?: number
  userId?: string | null
}

export interface TranscriptionOutcome {
  text: string | null
  /** Why `text` is null: 'empty transcript', 'silence artifact', a timeout… */
  errorMessage: string | null
}

// The HTTP call and its interpretation, split out so transcribeAudio stays a
// flat guard / call / log sequence.
async function requestTranscription(
  baseUrl: string,
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string,
  signal: AbortSignal,
): Promise<TranscriptionOutcome> {
  const apiKey = process.env.WHISPER_API_KEY

  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mimeType }), fileNameFor(mimeType))
  form.append('response_format', 'json')

  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    signal,
    // No content-type header: fetch sets the multipart boundary itself.
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
    body: form,
  })

  if (!res.ok) {
    console.error(`[whisper] transcription failed: HTTP ${res.status}`)
    return { text: null, errorMessage: `HTTP ${res.status}` }
  }

  const body = (await res.json()) as { text?: unknown }
  const raw = typeof body.text === 'string' ? body.text.trim() : ''
  if (!raw) return { text: null, errorMessage: 'empty transcript' }
  // Not an error: the user tapped the mic and said nothing.
  if (isLikelyHallucination(raw)) return { text: null, errorMessage: 'silence artifact' }
  return { text: raw, errorMessage: null }
}

function describeError(err: unknown): string {
  if ((err as Error)?.name === 'AbortError') {
    console.error('[whisper] transcription timed out')
    return 'timeout'
  }
  console.error('[whisper] transcription errored:', err)
  return err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500)
}

/**
 * Transcribe a recording.
 *
 * `text` is null when transcription is unavailable, fails, or produced only
 * a known silence artifact — `errorMessage` says which, so callers can tell
 * the user something better than "didn't catch that".
 */
export async function transcribeAudio(input: TranscribeInput): Promise<TranscriptionOutcome> {
  if (!isWhisperConfigured()) return { text: null, errorMessage: 'not configured' }
  if (input.audio.byteLength === 0) return { text: null, errorMessage: 'empty audio' }
  if (input.audio.byteLength > MAX_AUDIO_BYTES) {
    console.error(`[whisper] audio too large: ${input.audio.byteLength} bytes`)
    return { text: null, errorMessage: 'audio too large' }
  }

  const baseUrl = (process.env.WHISPER_BASE_URL ?? '').replace(/\/$/, '')
  const mimeType = input.mimeType || 'audio/wav'
  // Copy into a fresh ArrayBuffer-backed view: satisfies BlobPart's stricter
  // typing and avoids aliasing Node's Buffer pool.
  const bytes = new Uint8Array(input.audio.byteLength)
  bytes.set(input.audio)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 30_000)
  const startedAt = new Date()
  const t0 = performance.now()
  let outcome: TranscriptionOutcome = { text: null, errorMessage: null }

  try {
    outcome = await requestTranscription(baseUrl, bytes, mimeType, controller.signal)
  } catch (err) {
    outcome = { text: null, errorMessage: describeError(err) }
  } finally {
    clearTimeout(timer)
    const ms = Math.round(performance.now() - t0)
    logLlmCall({
      kind: 'transcribe',
      userId: input.userId,
      model: MODEL_LABEL,
      startedAt,
      durationMs: Math.max(0, ms),
      success: outcome.text !== null,
      errorMessage: outcome.errorMessage,
      messages: [{ role: 'user', content: `[audio ${input.audio.byteLength} bytes ${mimeType}]` }],
      response: outcome.text,
    })
  }

  return outcome
}

// whisper.cpp picks its decoder from the extension, so the name must match
// the payload even though the content is what actually matters.
function fileNameFor(mimeType: string): string {
  if (mimeType.includes('webm')) return 'audio.webm'
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'audio.mp4'
  if (mimeType.includes('ogg')) return 'audio.ogg'
  if (mimeType.includes('mpeg')) return 'audio.mp3'
  return 'audio.wav'
}
