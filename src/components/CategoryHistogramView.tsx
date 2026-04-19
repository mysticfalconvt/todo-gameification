// Presentational histogram for category bars. Accepts the bars directly so
// it can render data for any user (self, friend, public profile) — the
// loader lives where the data comes from.
import { useMemo } from 'react'

export interface CategoryBar {
  slug: string | null
  label: string
  color: string
  count: number
}

/** Reorder bars so the tallest sits near the center and heights taper to
 *  each side — a "bell curve" shape. */
function toBellOrder(bars: CategoryBar[]): CategoryBar[] {
  const sorted = [...bars].sort((a, b) => b.count - a.count)
  const n = sorted.length
  const result = new Array<CategoryBar>(n)
  const center = Math.floor(n / 2)
  let pos = 0
  if (n > 0) result[center] = sorted[pos++]
  for (let off = 1; off <= Math.ceil(n / 2) && pos < n; off++) {
    if (center + off < n && pos < n) result[center + off] = sorted[pos++]
    if (center - off >= 0 && pos < n) result[center - off] = sorted[pos++]
  }
  return result.filter(Boolean)
}

export function CategoryHistogramView({
  bars,
  compact = false,
}: {
  bars: CategoryBar[]
  compact?: boolean
}) {
  const ordered = useMemo(
    () => toBellOrder(bars.filter((b) => b.count > 0)),
    [bars],
  )
  const max = ordered.reduce((acc, b) => Math.max(acc, b.count), 0)

  if (ordered.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-[var(--sea-ink-soft)]">
        Nothing to show.
      </p>
    )
  }

  const BAR_MAX_PX = compact ? 56 : 96
  const MIN_PX = 6

  return (
    <div className="flex items-end gap-1.5">
      {ordered.map((b) => {
        const barHeight =
          max === 0 ? MIN_PX : Math.max((b.count / max) * BAR_MAX_PX, MIN_PX)
        return (
          <div
            key={b.slug ?? 'uncategorized'}
            className="flex min-w-0 flex-1 flex-col items-center gap-1"
            title={`${b.label}: ${b.count}`}
          >
            <span className="text-[10px] font-semibold text-[var(--sea-ink-soft)]">
              {b.count}
            </span>
            <div
              className="w-full rounded-t-md"
              style={{
                height: `${barHeight}px`,
                backgroundColor: b.color,
              }}
            />
            <span
              className="max-w-full truncate text-[10px] text-[var(--sea-ink-soft)]"
              title={b.label}
            >
              {b.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}
