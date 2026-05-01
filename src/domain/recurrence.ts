import { dayOfWeekInTz, nextOccurrenceAt, pinDateInTz, setTimeInTz } from './time'
import { formatInTimeZone } from 'date-fns-tz'

// Legacy `days: number` shape is still accepted on read; new writes use
// the `amount + unit` shape so the same type can express "every 2 hours"
// or "30 minutes after done." No SQL migration needed — `tasks.recurrence`
// is jsonb and readers tolerate both shapes.
export type DurationUnit = 'minutes' | 'hours' | 'days'

// `monthly_weekday.week` is 1..4 for the first/second/third/fourth
// occurrence of `dayOfWeek` in the month, or -1 for the last. We omit "5th"
// because it doesn't exist in every month and its semantics get fuzzy.
export type MonthlyWeekIndex = 1 | 2 | 3 | 4 | -1

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
  | { type: 'monthly_day'; dayOfMonth: number }
  | {
      type: 'monthly_weekday'
      week: MonthlyWeekIndex
      dayOfWeek: number
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

// month is 1..12. Returns the number of days in that month (handles leap years).
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

// Advance (year, month) by one calendar month, where month is 1..12.
function addOneMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
}

// Return the day-of-month (1..31) for the nth occurrence of `dayOfWeek` in the
// given month. Returns -1 if it doesn't exist (e.g. some months have only four
// Tuesdays — but we never offer the 5th in the UI, so this only matters
// defensively).
function nthWeekdayDay(
  year: number,
  month: number,
  week: MonthlyWeekIndex,
  dayOfWeek: number,
): number {
  if (week > 0) {
    for (let day = 1; day <= 7; day++) {
      const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
      if (dow === dayOfWeek) {
        const target = day + (week - 1) * 7
        return target <= daysInMonth(year, month) ? target : -1
      }
    }
    return -1
  }
  const last = daysInMonth(year, month)
  for (let day = last; day >= last - 6 && day >= 1; day--) {
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
    if (dow === dayOfWeek) return day
  }
  return -1
}

function buildUnpinnedDate(
  year: number,
  month: number,
  day: number,
  timeFrom: Date,
): Date {
  return new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      timeFrom.getUTCHours(),
      timeFrom.getUTCMinutes(),
      timeFrom.getUTCSeconds(),
      timeFrom.getUTCMilliseconds(),
    ),
  )
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

    case 'monthly_day': {
      const dom = recurrence.dayOfMonth
      if (hasLocalPin) {
        const ym = formatInTimeZone(previousDueAt, timeZone!, 'yyyy-MM')
        const [yStr, mStr] = ym.split('-')
        const { year, month } = addOneMonth(Number(yStr), Number(mStr))
        const day = Math.min(dom, daysInMonth(year, month))
        return pinDateInTz(year, month, day, timeOfDay!, timeZone!)
      }
      const { year, month } = addOneMonth(
        previousDueAt.getUTCFullYear(),
        previousDueAt.getUTCMonth() + 1,
      )
      const day = Math.min(dom, daysInMonth(year, month))
      return buildUnpinnedDate(year, month, day, previousDueAt)
    }

    case 'monthly_weekday': {
      const { week, dayOfWeek } = recurrence
      if (hasLocalPin) {
        const ym = formatInTimeZone(previousDueAt, timeZone!, 'yyyy-MM')
        const [yStr, mStr] = ym.split('-')
        let year = Number(yStr)
        let month = Number(mStr)
        let advanced = addOneMonth(year, month)
        year = advanced.year
        month = advanced.month
        let day = nthWeekdayDay(year, month, week, dayOfWeek)
        while (day < 0) {
          advanced = addOneMonth(year, month)
          year = advanced.year
          month = advanced.month
          day = nthWeekdayDay(year, month, week, dayOfWeek)
        }
        return pinDateInTz(year, month, day, timeOfDay!, timeZone!)
      }
      let year = previousDueAt.getUTCFullYear()
      let month = previousDueAt.getUTCMonth() + 1
      let advanced = addOneMonth(year, month)
      year = advanced.year
      month = advanced.month
      let day = nthWeekdayDay(year, month, week, dayOfWeek)
      while (day < 0) {
        advanced = addOneMonth(year, month)
        year = advanced.year
        month = advanced.month
        day = nthWeekdayDay(year, month, week, dayOfWeek)
      }
      return buildUnpinnedDate(year, month, day, previousDueAt)
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

  if (recurrence?.type === 'monthly_day') {
    const ym = formatInTimeZone(now, timeZone, 'yyyy-MM')
    const [yStr, mStr] = ym.split('-')
    let year = Number(yStr)
    let month = Number(mStr)
    let day = Math.min(recurrence.dayOfMonth, daysInMonth(year, month))
    let candidate = pinDateInTz(year, month, day, timeOfDay, timeZone)
    if (candidate > now) return candidate
    const advanced = addOneMonth(year, month)
    year = advanced.year
    month = advanced.month
    day = Math.min(recurrence.dayOfMonth, daysInMonth(year, month))
    return pinDateInTz(year, month, day, timeOfDay, timeZone)
  }

  if (recurrence?.type === 'monthly_weekday') {
    const ym = formatInTimeZone(now, timeZone, 'yyyy-MM')
    const [yStr, mStr] = ym.split('-')
    let year = Number(yStr)
    let month = Number(mStr)
    let day = nthWeekdayDay(year, month, recurrence.week, recurrence.dayOfWeek)
    if (day > 0) {
      const candidate = pinDateInTz(year, month, day, timeOfDay, timeZone)
      if (candidate > now) return candidate
    }
    while (true) {
      const advanced = addOneMonth(year, month)
      year = advanced.year
      month = advanced.month
      day = nthWeekdayDay(year, month, recurrence.week, recurrence.dayOfWeek)
      if (day > 0) {
        return pinDateInTz(year, month, day, timeOfDay, timeZone)
      }
    }
  }

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
