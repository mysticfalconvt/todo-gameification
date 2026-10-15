// Resolution of a *symbolic* when-clause into a concrete due instant.
//
// Voice capture asks the LLM for a task's timing, and the one thing an LLM
// is reliably bad at is calendar arithmetic — "next Tuesday at noon" is a
// date computation, not a language task, and models get it wrong in ways
// that are invisible until someone misses a chore. So the model emits a
// `VoiceWhen` (a weekday index, a day offset, a day-part name) and this
// module does the math, in the user's timezone, with date-fns-tz.
//
// Day parts resolve through DAY_PART_TIME, whose values are chosen to land
// inside the matching bucket in domain/dayParts.ts — so a spoken "Tuesday
// afternoon" and a /today view's "Afternoon" section always agree. The
// round-trip is asserted in the tests.
import { formatInTimeZone } from 'date-fns-tz'
import { type DayPart, TIMED_DAY_PARTS } from './dayParts'
import type { DurationUnit } from './recurrence'
import { assertValidTimeOfDay, pinDateInTz } from './time'

export type TimedDayPart = Exclude<DayPart, 'anytime'>

// Representative HH:MM for each spoken day part. Each value must bucket back
// to its own key via partForTimeOfDay (domain/dayParts.ts boundaries:
// morning 05–12, afternoon 12–17, evening 17–22, night 22–05).
export const DAY_PART_TIME: Record<TimedDayPart, string> = {
  morning: '09:00',
  afternoon: '12:00',
  evening: '18:00',
  night: '22:00',
}

// A date with no spoken time is due by the end of that local day rather than
// at some invented o'clock. `timeOfDay` stays null so the UI renders it as
// an anytime task, and the punctuality curve only starts docking once the
// day is actually over.
const END_OF_DAY = '23:59'

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/** Optional time refinement shared by the dated variants. */
interface WhenTime {
  /** Explicit HH:MM ("at 3:30") — wins over `part` when both are present. */
  time?: string | null
  /** Spoken day part ("Tuesday afternoon"). */
  part?: TimedDayPart | null
}

export type VoiceWhen =
  /** No timing spoken at all — the task lands in Someday. */
  | { kind: 'none' }
  /** Calendar days from today in the user's timezone. 0 = today, 1 = tomorrow. */
  | ({ kind: 'day_offset'; offset: number } & WhenTime)
  /** The next occurrence of a weekday. 0 = Sunday, matching dayOfWeekInTz. */
  | ({ kind: 'next_weekday'; weekday: number } & WhenTime)
  /** "in two hours", "in 20 minutes" — an offset from now, not a wall clock. */
  | { kind: 'in_duration'; amount: number; unit: DurationUnit }
  /** A spoken calendar date, YYYY-MM-DD in the user's timezone. */
  | ({ kind: 'absolute'; date: string } & WhenTime)

export interface ResolvedWhen {
  /** Absolute instant for the first occurrence (ISO), or null for Someday. */
  dueAtOverride: string | null
  /** HH:MM to persist on the task, or null when no time was spoken. */
  timeOfDay: string | null
}

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const MS_PER_DAY = 24 * MS_PER_HOUR

// Calendar-date arithmetic done on a noon-UTC anchor. Noon is far enough from
// either boundary that no DST shift can roll the date over, so adding days is
// pure and never needs timezone awareness.
function addLocalDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function weekdayOfLocalDate(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay()
}

function pinLocalDate(date: string, timeOfDay: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number)
  return pinDateInTz(year, month, day, timeOfDay, timeZone)
}

function isTimedDayPart(value: unknown): value is TimedDayPart {
  return TIMED_DAY_PARTS.includes(value as DayPart)
}

function intIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

// Explicit time wins, then the day part, then null (= anytime that day).
function resolveSpokenTime(when: WhenTime): string | null {
  if (when.time) {
    assertValidTimeOfDay(when.time)
    return when.time
  }
  if (when.part) {
    if (!isTimedDayPart(when.part)) throw new Error(`invalid day part: ${when.part}`)
    return DAY_PART_TIME[when.part]
  }
  return null
}

function msForDuration(amount: number, unit: DurationUnit): number {
  switch (unit) {
    case 'minutes':
      return amount * MS_PER_MINUTE
    case 'hours':
      return amount * MS_PER_HOUR
    case 'days':
      return amount * MS_PER_DAY
  }
}

// Every dated variant ends the same way: resolve the spoken time (falling
// back to end-of-day) and pin it to a local calendar date.
function onLocalDate(date: string, when: WhenTime, timeZone: string): ResolvedWhen {
  const timeOfDay = resolveSpokenTime(when)
  const at = pinLocalDate(date, timeOfDay ?? END_OF_DAY, timeZone)
  return { dueAtOverride: at.toISOString(), timeOfDay }
}

// Validation is table-driven: one predicate per variant, so adding a variant
// is a single entry rather than another branch in a growing switch.
type WhenOf<K extends VoiceWhen['kind']> = Extract<VoiceWhen, { kind: K }>

const WHEN_VALIDATORS: { [K in VoiceWhen['kind']]: (when: WhenOf<K>) => boolean } = {
  none: () => true,
  in_duration: (w) => Number.isFinite(w.amount) && w.amount > 0,
  day_offset: (w) => intIn(w.offset, 0, 365),
  next_weekday: (w) => intIn(w.weekday, 0, 6),
  absolute: (w) => ISO_DATE.test(w.date),
}

function assertResolvable(when: VoiceWhen): void {
  const validate = WHEN_VALIDATORS[when.kind] as (w: VoiceWhen) => boolean
  if (!validate?.(when)) {
    throw new Error(`unresolvable when-clause: ${JSON.stringify(when)}`)
  }
}

// Days from today to the target weekday. Today counts only when the spoken
// moment hasn't passed yet ("Tuesday afternoon" said on Tuesday morning);
// otherwise the speaker meant the one a week out.
function daysUntilWeekday(
  when: VoiceWhen & { kind: 'next_weekday' },
  today: string,
  now: Date,
  timeZone: string,
): number {
  const delta = (when.weekday - weekdayOfLocalDate(today) + 7) % 7
  if (delta !== 0) return delta
  const sameDay = pinLocalDate(today, resolveSpokenTime(when) ?? END_OF_DAY, timeZone)
  return sameDay.getTime() > now.getTime() ? 0 : 7
}

/**
 * Turn a symbolic when-clause into a concrete due instant.
 *
 * Throws on malformed input — callers treat a throw the same as a failed
 * parse and fall back to the review sheet with no date pre-filled, so a
 * confused model can never produce a silently wrong due date.
 */
export function resolveVoiceWhen(when: VoiceWhen, now: Date, timeZone: string): ResolvedWhen {
  assertResolvable(when)
  const today = formatInTimeZone(now, timeZone, 'yyyy-MM-dd')

  switch (when.kind) {
    case 'none':
      return { dueAtOverride: null, timeOfDay: null }
    case 'in_duration': {
      // A relative offset is a precise instant, not a recurring wall-clock
      // time, so nothing is pinned to timeOfDay.
      const at = new Date(now.getTime() + msForDuration(when.amount, when.unit))
      return { dueAtOverride: at.toISOString(), timeOfDay: null }
    }
    case 'day_offset':
      return onLocalDate(addLocalDays(today, when.offset), when, timeZone)
    case 'next_weekday':
      return onLocalDate(
        addLocalDays(today, daysUntilWeekday(when, today, now, timeZone)),
        when,
        timeZone,
      )
    case 'absolute':
      return onLocalDate(when.date, when, timeZone)
  }
}
