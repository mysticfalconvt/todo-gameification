// Quiet-hours math. Pure functions so the server and tests can share logic.
//
// A quiet window is stored as two local `HH:MM` strings. When start < end,
// the window is a same-day slice (e.g., 13:00–17:00). When start > end, it
// wraps across midnight (e.g., 22:00–07:00 = "after 10pm through 7am").
// start === end is treated as "no window" (nothing is ever quiet).

// Validate + normalize a quiet-hours window from raw HH:MM inputs. Each
// value must be a valid time (or null/empty for "unset"); an invalid time
// throws. A half-set window (only one end) collapses to "no window",
// matching the self-serve setter in functions/user.ts.
export function normalizeQuietHours(
  start: string | null,
  end: string | null,
): { start: string | null; end: string | null } {
  const parse = (v: string | null): string | null => {
    if (v === null || v === '') return null
    if (toMinutes(v) === null) {
      throw new Error('Time must be HH:MM between 00:00 and 23:59.')
    }
    return v
  }
  const s = parse(start)
  const e = parse(end)
  return s && e ? { start: s, end: e } : { start: null, end: null }
}

export function toMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

function localMinutesAt(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  // en-US hour12:false returns "24" for midnight in some runtimes — normalize.
  const h = hour === 24 ? 0 : hour
  return h * 60 + minute
}

export function isInQuietHours(
  at: Date,
  start: string | null,
  end: string | null,
  timeZone: string,
): boolean {
  if (!start || !end) return false
  const s = toMinutes(start)
  const e = toMinutes(end)
  if (s === null || e === null || s === e) return false
  const cur = localMinutesAt(at, timeZone)
  if (s < e) return cur >= s && cur < e
  // Wraps midnight: quiet is [s..1439] ∪ [0..e).
  return cur >= s || cur < e
}
