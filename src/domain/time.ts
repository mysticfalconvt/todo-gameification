import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

export function assertValidTimeOfDay(value: string): void {
  if (!HHMM.test(value)) {
    throw new Error(`invalid timeOfDay: ${value} (expected HH:MM)`)
  }
}

// Per-weekday time overrides for a recurring task. Keys are weekday indices
// '0'..'6' where 0 = Sunday (matching dayOfWeekInTz and the weekly recurrence
// daysOfWeek convention); values are HH:MM. A weekday absent from the map falls
// back to the task's base timeOfDay — so a task with no map (the common case)
// behaves exactly as before.
export type WeekdayTimes = Record<string, string>

export function assertValidWeekdayTimes(map: WeekdayTimes): void {
  for (const [key, value] of Object.entries(map)) {
    const day = Number(key)
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new Error(`invalid weekday key: ${key} (expected 0-6)`)
    }
    assertValidTimeOfDay(value)
  }
}

// Resolve the effective HH:MM for a weekday: the override if present, else base.
export function resolveTimeOfDay(
  weekday: number,
  base: string,
  map?: WeekdayTimes | null,
): string {
  return map?.[String(weekday)] ?? base
}

export function setTimeInTz(
  dayAnchor: Date,
  timeOfDay: string,
  timeZone: string,
): Date {
  assertValidTimeOfDay(timeOfDay)
  const localDate = formatInTimeZone(dayAnchor, timeZone, 'yyyy-MM-dd')
  return fromZonedTime(`${localDate}T${timeOfDay}:00`, timeZone)
}

// Build a Date for a specific calendar day in a timezone at HH:MM. Unlike
// setTimeInTz, this takes year/month/day directly so callers don't have to
// fabricate an anchor Date that lands on the right local day.
export function pinDateInTz(
  year: number,
  month: number,
  day: number,
  timeOfDay: string,
  timeZone: string,
): Date {
  assertValidTimeOfDay(timeOfDay)
  const yyyy = String(year).padStart(4, '0')
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return fromZonedTime(`${yyyy}-${mm}-${dd}T${timeOfDay}:00`, timeZone)
}

export function nextOccurrenceAt(
  from: Date,
  timeOfDay: string,
  timeZone: string,
): Date {
  let candidate = setTimeInTz(from, timeOfDay, timeZone)
  if (candidate > from) return candidate

  let anchor = new Date(from.getTime() + 86_400_000)
  const fromDay = formatInTimeZone(from, timeZone, 'yyyy-MM-dd')
  while (formatInTimeZone(anchor, timeZone, 'yyyy-MM-dd') === fromDay) {
    anchor = new Date(anchor.getTime() + 3_600_000)
  }
  return setTimeInTz(anchor, timeOfDay, timeZone)
}

export function dayOfWeekInTz(date: Date, timeZone: string): number {
  return Number(formatInTimeZone(date, timeZone, 'i')) % 7
}
