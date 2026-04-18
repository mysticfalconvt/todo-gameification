import { dayOfWeekInTz, nextOccurrenceAt, setTimeInTz } from './time'

export type Recurrence =
  | { type: 'daily' }
  | { type: 'weekly'; daysOfWeek: number[] }
  | { type: 'interval'; days: number }
  | { type: 'after_completion'; days: number }

const MS_PER_DAY = 86_400_000

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY)
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
      const next = addDays(previousDueAt, recurrence.days)
      return hasLocalPin ? setTimeInTz(next, timeOfDay!, timeZone!) : next
    }

    case 'after_completion': {
      const next = addDays(completedAt, recurrence.days)
      return hasLocalPin ? setTimeInTz(next, timeOfDay!, timeZone!) : next
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
