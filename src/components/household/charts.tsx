// Household-specific charts. Pure inline SVG — same pattern as the
// personal stats charts in src/components/stats/charts.tsx. No chart
// library. Each series gets its own color from `household_members.color`.

export interface HouseholdSeries {
  userId: string
  name: string
  handle: string
  color: string | null
  totalXp: number
  totalCount: number
  daily: number[]
  dailyCount: number[]
}

const FALLBACK_COLOR = '#4fb8b2'

function colorOf(s: { color: string | null }): string {
  return s.color ?? FALLBACK_COLOR
}

// Per-member totals as a horizontal bar chart. Each bar shows the
// member's completion count alongside their percentage of household
// total. Sorted by count descending. Tiny variant fits inline on the
// Chores tab; the full variant lives on the Stats tab.
export function HouseholdCompletionBar({
  members,
  totalCompletions,
  variant = 'full',
  title = 'Completions',
}: {
  members: HouseholdSeries[]
  totalCompletions: number
  variant?: 'full' | 'compact'
  title?: string
}) {
  const total = Math.max(totalCompletions, 1)
  const sorted = [...members].sort((a, b) => b.totalCount - a.totalCount)
  const compact = variant === 'compact'

  return (
    <section
      className={`island-shell rounded-2xl ${compact ? 'p-3' : 'p-4'}`}
    >
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">{title}</h2>
        <p className="text-xs text-[var(--sea-ink-soft)]">
          {totalCompletions === 0
            ? 'No chores done yet.'
            : `${totalCompletions} total`}
        </p>
      </header>
      {totalCompletions === 0 ? (
        <p className="text-xs text-[var(--sea-ink-soft)]">
          Complete a chore to start the chart.
        </p>
      ) : (
        <ul className="space-y-2">
          {sorted.map((m) => {
            const pct = Math.round((m.totalCount / total) * 100)
            return (
              <li key={m.userId} className="text-xs">
                <div className="mb-0.5 flex items-baseline justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden
                      className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
                      style={{ backgroundColor: colorOf(m) }}
                    />
                    <span className="truncate font-semibold text-[var(--sea-ink)]">
                      {m.name}
                    </span>
                  </span>
                  <span className="flex-shrink-0 tabular-nums text-[var(--sea-ink-soft)]">
                    {m.totalCount} · {pct}%
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[var(--option-bg)]">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: colorOf(m),
                    }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// Multi-series line chart: one polyline per household member, colored
// by their household_members.color. Used by the Stats tab to show
// daily XP per family member over the window. Y-axis is shared across
// all series so members compete visually.
export function HouseholdXpMultiLine({
  members,
  dateKeys,
  label = 'XP per day per family member',
  metric = 'xp',
}: {
  members: HouseholdSeries[]
  dateKeys: string[]
  label?: string
  metric?: 'xp' | 'count'
}) {
  if (dateKeys.length === 0) {
    return (
      <section className="island-shell rounded-2xl p-4">
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">{label}</h2>
        <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
          No data in this window yet.
        </p>
      </section>
    )
  }

  const seriesFor = (m: HouseholdSeries): number[] =>
    metric === 'xp' ? m.daily : m.dailyCount

  // Global max across all members so series are comparable. Min 1 so
  // an all-zero state still renders a flat baseline at the bottom.
  let max = 1
  for (const m of members) {
    for (const v of seriesFor(m)) {
      if (v > max) max = v
    }
  }

  const width = 600
  const height = 160
  const padX = 8
  const padY = 8
  const n = dateKeys.length
  const stepX = n > 1 ? (width - padX * 2) / (n - 1) : 0

  function pointsFor(daily: number[]): string {
    return daily
      .map((v, i) => {
        const x = padX + i * stepX
        const y = height - padY - (v / max) * (height - padY * 2)
        return `${x},${y}`
      })
      .join(' ')
  }

  return (
    <section className="island-shell rounded-2xl p-4">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">{label}</h2>
        <p className="text-xs text-[var(--sea-ink-soft)]">
          {n}-day window
        </p>
      </header>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-40 w-full"
        preserveAspectRatio="none"
      >
        {/* Baseline / grid is implicit via the polylines themselves —
            keep it visually quiet so multiple series can overlap. */}
        {members.map((m) => (
          <polyline
            key={m.userId}
            points={pointsFor(seriesFor(m))}
            fill="none"
            stroke={colorOf(m)}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={m.totalXp === 0 && m.totalCount === 0 ? 0.25 : 0.9}
          />
        ))}
      </svg>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {members.map((m) => (
          <li
            key={m.userId}
            className="flex items-center gap-1.5 text-xs text-[var(--sea-ink-soft)]"
          >
            <span
              aria-hidden
              className="inline-block h-2 w-3 rounded-sm"
              style={{ backgroundColor: colorOf(m) }}
            />
            <span className="font-semibold text-[var(--sea-ink)]">
              {m.name}
            </span>
            <span className="tabular-nums">
              {metric === 'xp' ? `${m.totalXp} XP` : `${m.totalCount}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
