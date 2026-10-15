// Spoken transcript -> structured task draft.
//
// Two rules shape this file:
//
// 1. The model never does calendar arithmetic. It describes timing
//    symbolically ("the next Tuesday, afternoon") and domain/voiceWhen.ts
//    resolves it against the user's timezone. Models are confidently wrong
//    at date math in a way that is invisible until a chore is missed.
//
// 2. The wire schema is FLAT, not a discriminated union. Grammar-constrained
//    decoding is reliable on enums and scalars and flaky on deep `anyOf`,
//    so the model fills one object with sentinel values ('none', '', 0) for
//    the fields that don't apply, and `narrow*` below turns that into the
//    real VoiceWhen / Recurrence unions. Everything is in `required` because
//    strict json_schema demands it.
//
// Returns null on any failure — not configured, timeout, unparseable, or
// a nonsense field. Callers fall back to the review sheet with the raw
// transcript as the title, so a bad parse never costs the capture.
import { formatInTimeZone } from 'date-fns-tz'
import {
  type DurationUnit,
  type MonthlyWeekIndex,
  type Recurrence,
  resolveDuration,
} from '../../domain/recurrence'
import type { TimedDayPart, VoiceWhen } from '../../domain/voiceWhen'
import { callLlmChat, isLlmConfigured } from './client'

const SYSTEM_PROMPT = `You turn a spoken todo into structured JSON for a task app. The user dictated one sentence; capture what they meant.

WEEKDAY NUMBERS — used by when.weekday, recurrence.daysOfWeek AND recurrence.dayOfWeek:
Sunday=0  Monday=1  Tuesday=2  Wednesday=3  Thursday=4  Friday=5  Saturday=6
Check this table every time you write a weekday number. Monday is 1, not 2.

TIMING — THE MOST IMPORTANT RULE
Never compute a calendar date yourself. Describe timing symbolically; the app resolves it in the user's timezone.
- "today", "tonight", "this morning", "this evening", "later" -> kind "day_offset" with dayOffset 0. Tonight is TODAY.
- "tomorrow", "tomorrow morning" -> kind "day_offset" with dayOffset 1. "in three days" -> dayOffset 3.
- any weekday name ("Tuesday", "next Friday") -> kind "next_weekday" with that weekday number. Do NOT work out the date.
- "in two hours", "in 20 minutes", "in two weeks" -> kind "in_duration" with amount + unit.
- a spoken calendar date ("November 3rd") -> kind "absolute" with date YYYY-MM-DD. Use the current year unless the month has already passed.
- no timing mentioned at all -> kind "none".

TIME OF DAY
- Spoken clock time ("at 3:30", "at 7pm") -> time "HH:MM" in 24h. Otherwise time "".
- Vague time words -> part: "morning", "afternoon", "evening" or "night". Otherwise part "none".
- Never invent a time that was not spoken. "Mow the lawn Tuesday" has part "none" and time "".

REPEATS
Set recurrence.type only when the user actually asks for something repeating ("every", "each", "daily", "weekly"). A one-off task has type "none".
- "every day" -> daily
- "every Tuesday", "every Monday and Thursday" -> weekly with daysOfWeek
- "every 3 days", "every two weeks", "every 6 hours" -> interval with amount + unit
- "two weeks after I finish it" -> after_completion with amount + unit
- "on the 15th of every month" -> monthly_day with dayOfMonth
- "the first Monday of the month" -> monthly_weekday with week (1..4, or -1 for last) and dayOfWeek
If a repeat cannot be expressed exactly (e.g. "every other Tuesday"), pick the closest option and still fill the timing fields.

DURATIONS — unit may ONLY be "minutes", "hours" or "days"
Convert every spoken duration into one of those three units. This applies identically to when.in_duration, recurrence.interval and recurrence.after_completion.
- "in two hours" -> amount 2, unit "hours"
- "in 20 minutes" -> amount 20, unit "minutes"
- "every 3 days" -> amount 3, unit "days"
- "in two weeks" / "every two weeks" / "two weeks after I finish it" -> amount 14, unit "days"
- "every month" -> amount 30, unit "days"
- "every six months" -> amount 180, unit "days"
- "every year" -> amount 365, unit "days"
A week is never 1 and never 2 — it is 7 days. Multiply before you answer.

TITLE AND NOTES
- title: a short imperative task name, using THE USER'S OWN WORDS. Never swap in a synonym: "mow the lawn" -> "Mow the lawn", never "Mow the grass".
- Strip only filler like "I need to", "I should", "remind me to". Keep the user's plurals and wording: "the bins" stays "the bins", "the gutters" stays "the gutters".
- Do NOT put the timing in the title. No "Mow the lawn Tuesday".
- notes: only genuine extra detail the user spoke beyond the title and timing. Otherwise "".

WORKED EXAMPLES
"I need to mow the lawn on Tuesday afternoon"
  title "Mow the lawn", when kind "next_weekday" weekday 2 part "afternoon", recurrence type "none"
"pay the mortgage the first Monday of every month"
  title "Pay the mortgage", when kind "none", recurrence type "monthly_weekday" week 1 dayOfWeek 1
"check the smoke alarms every six months"
  title "Check the smoke alarms", when kind "none", recurrence type "interval" amount 180 unit "days"
"take the bins out every Wednesday evening"
  title "Take the bins out", when kind "next_weekday" weekday 3 part "evening", recurrence type "weekly" daysOfWeek [3]
"I should clean the gutters in two weeks"
  title "Clean the gutters", when kind "in_duration" amount 14 unit "days", recurrence type "none"
"put the bins out tonight"
  title "Put the bins out", when kind "day_offset" dayOffset 0 part "evening", recurrence type "none"

Output ONLY the JSON object.`

// ---------------------------------------------------------------------------
// Wire shape (flat, all fields required, sentinels for N/A)
// ---------------------------------------------------------------------------

const WHEN_KINDS = ['none', 'day_offset', 'next_weekday', 'in_duration', 'absolute'] as const
const PARTS = ['none', 'morning', 'afternoon', 'evening', 'night'] as const
const UNITS = ['minutes', 'hours', 'days'] as const
const RECURRENCE_TYPES = [
  'none',
  'daily',
  'weekly',
  'interval',
  'after_completion',
  'monthly_day',
  'monthly_weekday',
] as const

export interface RawWhen {
  kind: (typeof WHEN_KINDS)[number]
  dayOffset: number
  weekday: number
  date: string
  amount: number
  unit: DurationUnit
  part: (typeof PARTS)[number]
  time: string
}

export interface RawRecurrence {
  type: (typeof RECURRENCE_TYPES)[number]
  daysOfWeek: number[]
  amount: number
  unit: DurationUnit
  dayOfMonth: number
  week: number
  dayOfWeek: number
}

interface RawDraft {
  title: string
  notes: string
  when: RawWhen
  recurrence: RawRecurrence
}

const JSON_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'task_draft',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        notes: { type: 'string' },
        when: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: WHEN_KINDS },
            dayOffset: { type: 'integer', minimum: 0, maximum: 365 },
            weekday: { type: 'integer', minimum: 0, maximum: 6 },
            date: { type: 'string' },
            amount: { type: 'integer', minimum: 0 },
            unit: { type: 'string', enum: UNITS },
            part: { type: 'string', enum: PARTS },
            time: { type: 'string' },
          },
          required: ['kind', 'dayOffset', 'weekday', 'date', 'amount', 'unit', 'part', 'time'],
          additionalProperties: false,
        },
        recurrence: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: RECURRENCE_TYPES },
            daysOfWeek: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
            amount: { type: 'integer', minimum: 0 },
            unit: { type: 'string', enum: UNITS },
            dayOfMonth: { type: 'integer', minimum: 1, maximum: 31 },
            week: { type: 'integer', minimum: -1, maximum: 4 },
            dayOfWeek: { type: 'integer', minimum: 0, maximum: 6 },
          },
          required: ['type', 'daysOfWeek', 'amount', 'unit', 'dayOfMonth', 'week', 'dayOfWeek'],
          additionalProperties: false,
        },
      },
      required: ['title', 'notes', 'when', 'recurrence'],
      additionalProperties: false,
    },
  },
}

// ---------------------------------------------------------------------------
// Narrowing: flat wire shape -> domain unions
// ---------------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

function narrowPart(part: string): TimedDayPart | null {
  return part === 'morning' || part === 'afternoon' || part === 'evening' || part === 'night'
    ? part
    : null
}

function narrowTime(time: string): string | null {
  const trimmed = time?.trim() ?? ''
  return HHMM.test(trimmed) ? trimmed : null
}

function narrowUnit(unit: string): DurationUnit {
  return unit === 'minutes' || unit === 'hours' ? unit : 'days'
}

const MONTHLY_WEEKS = new Set<number>([1, 2, 3, 4, -1])

function intIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

const MAX_INT = Number.MAX_SAFE_INTEGER

/** Returns null when the model picked a kind but botched its payload. */
export function narrowWhen(raw: RawWhen): VoiceWhen | null {
  const part = narrowPart(raw.part)
  const time = narrowTime(raw.time)
  switch (raw.kind) {
    case 'none':
      return { kind: 'none' }
    case 'day_offset':
      return intIn(raw.dayOffset, 0, MAX_INT)
        ? { kind: 'day_offset', offset: raw.dayOffset, part, time }
        : null
    case 'next_weekday':
      return intIn(raw.weekday, 0, 6)
        ? { kind: 'next_weekday', weekday: raw.weekday, part, time }
        : null
    case 'in_duration':
      return intIn(raw.amount, 1, MAX_INT)
        ? { kind: 'in_duration', amount: raw.amount, unit: narrowUnit(raw.unit) }
        : null
    case 'absolute':
      return ISO_DATE.test(raw.date) ? { kind: 'absolute', date: raw.date, part, time } : null
    default:
      return null
  }
}

/** null means "not recurring" — both for type 'none' and for unusable payloads. */
export function narrowRecurrence(raw: RawRecurrence): Recurrence | null {
  switch (raw.type) {
    case 'daily':
      return { type: 'daily' }
    case 'weekly': {
      const days = [...new Set(raw.daysOfWeek ?? [])]
        .filter((d) => intIn(d, 0, 6))
        .sort((a, b) => a - b)
      return days.length > 0 ? { type: 'weekly', daysOfWeek: days } : null
    }
    case 'interval':
    case 'after_completion':
      return intIn(raw.amount, 1, MAX_INT)
        ? { type: raw.type, amount: raw.amount, unit: narrowUnit(raw.unit) }
        : null
    case 'monthly_day':
      return intIn(raw.dayOfMonth, 1, 31)
        ? { type: 'monthly_day', dayOfMonth: raw.dayOfMonth }
        : null
    case 'monthly_weekday':
      return MONTHLY_WEEKS.has(raw.week) && intIn(raw.dayOfWeek, 0, 6)
        ? {
            type: 'monthly_weekday',
            week: raw.week as MonthlyWeekIndex,
            dayOfWeek: raw.dayOfWeek,
          }
        : null
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Deterministic reconciliation against the transcript
// ---------------------------------------------------------------------------
//
// Two things the model gets wrong even at temperature 0, with worked examples
// in the prompt telling it otherwise:
//   - "the first Monday of every month" -> dayOfWeek 2 (Tuesday)
//   - "two weeks after I finish it"     -> amount 2, unit days
// Weekday names and duration words are closed, unambiguous vocabularies, so a
// regex settles them perfectly and we stop relying on model compliance. These
// only ever *correct* a field the model already chose to populate — they never
// invent timing the model didn't find.

const WEEKDAY_WORDS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
}

function weekdaysIn(transcript: string): number[] {
  const found = new Set<number>()
  for (const word of transcript.toLowerCase().match(/[a-z]+/g) ?? []) {
    const day = WEEKDAY_WORDS[word]
    if (day !== undefined) found.add(day)
  }
  return [...found].sort((a, b) => a - b)
}

// The model reaches for "days" and then forgets to scale. Only ever scales up,
// and only when the spoken unit is larger than what it emitted.
function scaleDuration(transcript: string, amount: number, unit: DurationUnit): number {
  if (unit !== 'days') return amount
  const t = transcript.toLowerCase()
  if (/\byears?\b/.test(t) && amount < 365) return amount * 365
  if (/\bmonths?\b/.test(t) && amount < 28) return amount * 30
  if (/\bweeks?\b/.test(t) && amount % 7 !== 0) return amount * 7
  return amount
}

/** Corrects weekday indices and duration scaling using the raw transcript. */
export function reconcileWithTranscript(draft: TaskDraft, transcript: string): TaskDraft {
  const days = weekdaysIn(transcript)
  let when = draft.when
  let recurrence = draft.recurrence

  // Only override when the model already committed to a weekday-based shape,
  // so "call Bob about the Friday meeting tomorrow" keeps its day_offset.
  if (when.kind === 'next_weekday' && days.length === 1 && when.weekday !== days[0]) {
    when = { ...when, weekday: days[0] }
  }
  if (when.kind === 'in_duration') {
    when = { ...when, amount: scaleDuration(transcript, when.amount, when.unit) }
  }

  if (recurrence?.type === 'weekly' && days.length > 0) {
    recurrence = { type: 'weekly', daysOfWeek: days }
  }
  if (recurrence?.type === 'monthly_weekday' && days.length === 1) {
    recurrence = { ...recurrence, dayOfWeek: days[0] }
  }
  if (recurrence?.type === 'interval' || recurrence?.type === 'after_completion') {
    const { amount, unit } = resolveDuration(recurrence)
    recurrence = { type: recurrence.type, amount: scaleDuration(transcript, amount, unit), unit }
  }

  return { ...draft, when, recurrence }
}

// ---------------------------------------------------------------------------

export interface TaskDraft {
  title: string
  notes: string | null
  when: VoiceWhen
  recurrence: Recurrence | null
}

export interface ParseTaskDraftInput {
  transcript: string
  timeZone: string
  /** Injected for tests; defaults to now. */
  now?: Date
  userId: string
}

export async function parseTaskDraft(input: ParseTaskDraftInput): Promise<TaskDraft | null> {
  if (!isLlmConfigured()) return null
  const transcript = input.transcript?.trim()
  if (!transcript) return null

  const now = input.now ?? new Date()
  // Grounding. Without an explicit "today is <weekday>", the model anchors on
  // whatever its training data suggests and picks the wrong Tuesday.
  const context = [
    `Current date: ${formatInTimeZone(now, input.timeZone, 'yyyy-MM-dd')}`,
    `Current day of week: ${formatInTimeZone(now, input.timeZone, 'EEEE')}`,
    `Current local time: ${formatInTimeZone(now, input.timeZone, 'HH:mm')}`,
    `User timezone: ${input.timeZone}`,
    '',
    `Transcript: "${transcript}"`,
  ].join('\n')

  const raw = await callLlmChat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: context },
    ],
    temperature: 0,
    maxTokens: 400,
    timeoutMs: 20_000,
    responseFormat: JSON_SCHEMA,
    track: { kind: 'voice_task', userId: input.userId },
  })

  const draft = toDraft(raw)
  return draft ? reconcileWithTranscript(draft, transcript) : null
}

export function toDraft(raw: string | null): TaskDraft | null {
  const data = parseJson(raw)
  if (!data) return null

  const title = typeof data.title === 'string' ? data.title.trim() : ''
  if (!title) return null

  const when = data.when ? narrowWhen(data.when) : null
  if (!when) return null

  const notes = typeof data.notes === 'string' && data.notes.trim() ? data.notes.trim() : null

  return {
    title,
    notes,
    when,
    recurrence: data.recurrence ? narrowRecurrence(data.recurrence) : null,
  }
}

// Same defensive extraction as categorizeTask: tolerate code fences and
// leading prose from a model that ignored the schema.
function parseJson(raw: string | null): Partial<RawDraft> | null {
  if (!raw) return null
  const stripped = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  try {
    return JSON.parse(stripped) as Partial<RawDraft>
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0]) as Partial<RawDraft>
    } catch {
      return null
    }
  }
}
