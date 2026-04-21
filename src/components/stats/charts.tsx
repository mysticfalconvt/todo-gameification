export function XpLineSection({
  data,
  label = 'XP per day',
}: {
  data: Array<{ date: string; xp: number; count: number }>
  label?: string
}) {
  const total = data.reduce((acc, d) => acc + d.xp, 0)
  const avg = data.length > 0 ? Math.round(total / data.length) : 0
  const max = data.reduce((acc, d) => Math.max(acc, d.xp), 0) || 1
  const width = 600
  const height = 120
  const padX = 4
  const n = data.length
  const stepX = n > 1 ? (width - padX * 2) / (n - 1) : 0
  const points = data
    .map((d, i) => {
      const x = padX + i * stepX
      const y = height - (d.xp / max) * (height - 8) - 4
      return `${x},${y}`
    })
    .join(' ')
  const area = `${padX},${height} ${points} ${padX + (n - 1) * stepX},${height}`

  return (
    <section className="island-shell rounded-2xl p-4">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">{label}</h2>
        <p className="text-xs text-[var(--sea-ink-soft)]">
          total {total} · avg {avg}/day
        </p>
      </header>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-32 w-full"
        preserveAspectRatio="none"
      >
        <polygon points={area} fill="var(--lagoon-deep)" fillOpacity="0.15" />
        <polyline
          points={points}
          fill="none"
          stroke="var(--lagoon-deep)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </section>
  )
}

export interface TimingOffsetData {
  buckets: Array<{ offsetMin: number; count: number }>
  totalScheduled: number
  avgOffsetMin: number
  withinThirtyCount: number
}

export function TimingDistributionSection({
  data,
  emptyMessage = 'Complete a few tasks with a scheduled time to see how close you land to them.',
}: {
  data: TimingOffsetData
  emptyMessage?: string
}) {
  if (data.totalScheduled === 0) {
    return (
      <section className="island-shell rounded-2xl p-4">
        <header className="mb-3">
          <h2 className="text-sm font-bold text-[var(--sea-ink)]">
            Timing curve
          </h2>
        </header>
        <p className="text-sm text-[var(--sea-ink-soft)]">{emptyMessage}</p>
      </section>
    )
  }

  const max = data.buckets.reduce((a, b) => Math.max(a, b.count), 0) || 1
  const width = 600
  const height = 120
  const padX = 4
  const n = data.buckets.length
  const stepX = n > 1 ? (width - padX * 2) / (n - 1) : 0

  const pts = data.buckets.map((b, i) => ({
    x: padX + i * stepX,
    y: height - (b.count / max) * (height - 8) - 4,
  }))
  const linePath = smoothPath(pts)
  const areaPath =
    pts.length > 1
      ? `${linePath} L ${pts[pts.length - 1].x},${height} L ${pts[0].x},${height} Z`
      : ''
  const zeroIdx = data.buckets.findIndex((b) => b.offsetMin === 0)
  const zeroX = zeroIdx >= 0 ? padX + zeroIdx * stepX : null

  const withinPct = Math.round(
    (data.withinThirtyCount / data.totalScheduled) * 100,
  )

  return (
    <section className="island-shell rounded-2xl p-4">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">
          Timing curve
        </h2>
        <p className="text-xs text-[var(--sea-ink-soft)]">
          {data.totalScheduled} scheduled · {withinPct}% within 30 min · avg{' '}
          {offsetLabel(data.avgOffsetMin)}
        </p>
      </header>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-32 w-full"
        preserveAspectRatio="none"
      >
        <path d={areaPath} fill="var(--lagoon-deep)" fillOpacity="0.15" />
        <path
          d={linePath}
          fill="none"
          stroke="var(--lagoon-deep)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {zeroX !== null && (
          <line
            x1={zeroX}
            y1={0}
            x2={zeroX}
            y2={height}
            stroke="var(--sea-ink-soft)"
            strokeWidth="1"
            strokeDasharray="3 3"
            opacity="0.55"
          />
        )}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-[var(--sea-ink-soft)]">
        <span>−3h</span>
        <span>−2h</span>
        <span>−1h</span>
        <span>on time</span>
        <span>+1h</span>
        <span>+2h</span>
        <span>+3h</span>
      </div>
    </section>
  )
}

// Monotone cubic Hermite interpolation (Fritsch-Carlson). Smooths the curve
// through every sample point without overshooting — so the line can't dip
// below 0 when a count falls sharply to a neighbor of 0.
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  const n = pts.length
  if (n === 0) return ''
  if (n === 1) return `M ${pts[0].x},${pts[0].y}`
  if (n === 2) return `M ${pts[0].x},${pts[0].y} L ${pts[1].x},${pts[1].y}`

  const dx = new Array<number>(n - 1)
  const m = new Array<number>(n - 1)
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x
    m[i] = (pts[i + 1].y - pts[i].y) / dx[i]
  }

  const t = new Array<number>(n)
  t[0] = m[0]
  t[n - 1] = m[n - 2]
  for (let i = 1; i < n - 1; i++) {
    t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2
  }
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0
      t[i + 1] = 0
      continue
    }
    const a = t[i] / m[i]
    const b = t[i + 1] / m[i]
    const s = a * a + b * b
    if (s > 9) {
      const tau = 3 / Math.sqrt(s)
      t[i] = tau * a * m[i]
      t[i + 1] = tau * b * m[i]
    }
  }

  let d = `M ${pts[0].x},${pts[0].y}`
  for (let i = 0; i < n - 1; i++) {
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const cp1x = p1.x + dx[i] / 3
    const cp1y = p1.y + (t[i] * dx[i]) / 3
    const cp2x = p2.x - dx[i] / 3
    const cp2y = p2.y - (t[i + 1] * dx[i]) / 3
    d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`
  }
  return d
}

function offsetLabel(min: number): string {
  if (min === 0) return 'on time'
  const abs = Math.abs(min)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  const mag = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`
  return min > 0 ? `${mag} late` : `${mag} early`
}
