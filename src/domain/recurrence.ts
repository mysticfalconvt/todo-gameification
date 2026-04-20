import { dayOfWeekInTz, nextOccurrenceAt, setTimeInTz } from './time'
import { formatInTimeZone } from 'date-fns-tz'

// Legacy `days: number` shape is still accepted on read; new writes use
// the `amount + unit` shape so the same type can express "every 2 hours"
// or "30 minutes after done." No SQL migration needed — `tasks.recurrence`
// is jsonb and readers tolerate both shapes.
export type DurationUnit = 'minutes' | 'hours' | 'days'

export type Recurrence =
  | { type: 'daily' }
  | { type: 'weekly'; daysOfWeek: number[] }
  | {
      type: 'interval'
      /** Legacy — kept for rows written before the unit split. */
      days?: number
      amount?: number
      unit?: DurationUnit
    }
  | {
      type: 'after_completion'
      /** Legacy — kept for rows written before the unit split. */
      days?: number
      amount?: number
      unit?: DurationUnit
    }

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const MS_PER_DAY = 24 * MS_PER_HOUR

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY)
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

// Pull {amount, unit} from either the new shape or the legacy {days}.
export function resolveDuration(r: {
  days?: number
  amount?: number
  unit?: DurationUnit
}): { amount: number; unit: DurationUnit } {
  if (typeof r.amount === 'number' && r.unit) {
    return { amount: r.amount, unit: r.unit }
  }
  return { amount: r.days ?? 1, unit: 'days' }
}

function startOfUtcDay(date: Date): Date {
  const d = new Date(date)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

export interface ComputeNextDueInput {
  recurrence: Recurrence
  previousDueAt: Date
  completedAt: Date
  timeOfDay?: string | null
  timeZone?: string | null
}

export function computeNextDue(input: ComputeNextDueInput): Date {
  const { recurrence, previousDueAt, completedAt, timeOfDay, timeZone } = input
  const hasLocalPin = Boolean(timeOfDay && timeZone)

  switch (recurrence.type) {
    case 'daily':
      return hasLocalPin
        ? nextOccurrenceAt(previousDueAt, timeOfDay!, timeZone!)
        : addDays(previousDueAt, 1)

    case 'weekly': {
      if (recurrence.daysOfWeek.length === 0) {
        throw new Error('weekly recurrence requires at least one day')
      }
      const sorted = [...recurrence.daysOfWeek].sort((a, b) => a - b)

      if (hasLocalPin) {
        for (let offset = 1; offset <= 7; offset++) {
          const candidate = addDays(previousDueAt, offset)
          if (sorted.includes(dayOfWeekInTz(candidate, timeZone!))) {
            return setTimeInTz(candidate, timeOfDay!, timeZone!)
          }
        }
        throw new Error('unreachable: no valid day-of-week in a 7-day window')
      }

      const fromDay = startOfUtcDay(previousDueAt)
      for (let offset = 1; offset <= 7; offset++) {
        const candidate = addDays(fromDay, offset)
        if (sorted.includes(candidate.getUTCDay())) {
          candidate.setUTCHours(
            previousDueAt.getUTCHours(),
            previousDueAt.getUTCMinutes(),
            previousDueAt.getUTCSeconds(),
            previousDueAt.getUTCMilliseconds(),
          )
          return candidate
        }
      }
      throw new Error('unreachable: no valid day-of-week in a 7-day window')
    }

    case 'interval': {
      const { amount, unit } = resolveDuration(recurrence)
      const next = new Date(
        previousDueAt.getTime() + msForDuration(amount, unit),
      )
      // Only pin to a local clock time for day-granular schedules.
      // Sub-day intervals (hours / minutes) are relative offsets and
      // pinning them to HH:MM would snap them to a fixed hour daily.
      return hasLocalPin && unit === 'days'
        ? setTimeInTz(next, timeOfDay!, timeZone!)
        : next
    }

    case 'after_completion': {
      const { amount, unit } = resolveDuration(recurrence)
      const next = new Date(
        completedAt.getTime() + msForDuration(amount, unit),
      )
      return hasLocalPin && unit === 'days'
        ? setTimeInTz(next, timeOfDay!, timeZone!)
        : next
    }
  }
}

export function firstDueAt(options: {
  now: Date
  recurrence: Recurrence | null
  timeOfDay: string | null
  timeZone: string
  someday?: boolean
}): Date | null {
  const { now, recurrence, timeOfDay, timeZone, someday } = options

  if (someday) return null
  if (!timeOfDay) return now

  if (!recurrence || recurrence.type !== 'weekly') {
    // For a one-off task the user explicitly picked a clock time for
    // today, so a past-time pick should fire immediately (marked
    // overdue) rather than silently rolling to tomorrow. Recurring
    // tasks still use nextOccurrenceAt so they advance to the next
    // scheduled occurrence.
    if (!recurrence) {
      const candidate = setTimeInTz(now, timeOfDay, timeZone)
      const sameLocalDay =
        formatInTimeZone(candidate, timeZone, 'yyyy-MM-dd') ===
        formatInTimeZone(now, timeZone, 'yyyy-MM-dd')
      if (sameLocalDay) return candidate
    }
    return nextOccurrenceAt(now, timeOfDay, timeZone)
  }

  if (recurrence.daysOfWeek.length === 0) {
    throw new Error('weekly recurrence requires at least one day')
  }
  const sorted = [...recurrence.daysOfWeek].sort((a, b) => a - b)
  for (let offset = 0; offset < 8; offset++) {
    const candidate = setTimeInTz(addDays(now, offset), timeOfDay, timeZone)
    if (
      sorted.includes(dayOfWeekInTz(candidate, timeZone)) &&
      candidate > now
    ) {
      return candidate
    }
  }
  throw new Error('unreachable: no valid day-of-week in an 8-day window')
}
