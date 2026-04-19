// Bucket a task's time-of-day into a coarse day-part so the /today view
// can surface "what's relevant now" without hiding the rest.
//
// Boundaries are intentionally fuzzy. They match how people talk about
// their day more than any clock-exact definition.

export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night' | 'anytime'

export const TIMED_DAY_PARTS: DayPart[] = [
  'morning',
  'afternoon',
  'evening',
  'night',
]

export const DAY_PART_LABEL: Record<DayPart, string> = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
  night: 'Night',
  anytime: 'Anytime',
}

function partForHour(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 22) return 'evening'
  return 'night' // 22:00–04:59
}

export function partForTimeOfDay(timeOfDay: string | null): DayPart {
  if (!timeOfDay) return 'anytime'
  const m = /^(\d{2}):(\d{2})$/.exec(timeOfDay)
  if (!m) return 'anytime'
  return partForHour(Number(m[1]))
}

export function currentDayPart(at: Date, timeZone: string): DayPart {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(at)
  const raw = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  // en-US hour12:false returns "24" for midnight in some runtimes.
  const hour = raw === 24 ? 0 : raw
  return partForHour(hour)
}

// Index into the timed-order array. Used to compare "is this bucket past
// or current compared to now?" Night wraps: when the current part is
// night, every other part is treated as future (tomorrow).
export function isBucketCurrentOrPast(
  bucket: DayPart,
  current: DayPart,
): boolean {
  if (bucket === 'anytime') return true
  const order: Record<DayPart, number> = {
    morning: 0,
    afternoon: 1,
    evening: 2,
    night: 3,
    anytime: -1,
  }
  return order[bucket] <= order[current]
}
