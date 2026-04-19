import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getStats, listCompletionHistory } from '../../server/functions/tasks'

export const Route = createFileRoute('/_authenticated/stats')({
  component: StatsPage,
})

type Range = 7 | 30 | 90 | 'all'

function StatsPage() {
  const [days, setDays] = useState<Range>(30)
  const query = useQuery({
    queryKey: ['stats', days],
    queryFn: () => getStats({ data: { days } }),
  })

  const stats = query.data

  return (
    <main className="page-wrap space-y-6 px-4 py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="island-kicker mb-1">Stats</p>
          <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
            Trends
          </h1>
          <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
            Based on <code>task.completed</code> events in the window.
          </p>
        </div>
        <div
          className="flex gap-1 rounded-full border border-[var(--line)] bg-[var(--option-bg)] p-1"
          role="radiogroup"
          aria-label="Window"
        >
          {([7, 30, 90, 'all'] as Range[]).map((r) => (
            <button
              key={String(r)}
              type="button"
              role="radio"
              aria-checked={days === r}
              onClick={() => setDays(r)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                days === r
                  ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                  : 'text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
              }`}
            >
              {r === 'all' ? 'All' : `${r}d`}
            </button>
          ))}
        </div>
      </header>

      {query.isLoading || !stats ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : (
        <>
          <XpLineSection data={stats.xpByDay} />
          <div className="grid gap-4 md:grid-cols-2">
            <WeekdaySection data={stats.weekday} />
            <HourSection data={stats.hour} />
          </div>
          <TopTasksSection tasks={stats.topTasks} />
          <HistorySection />
        </>
      )}
    </main>
  )
}

function HistorySection() {
  const [search, setSearch] = useState('')
  const query = useQuery({
    queryKey: ['history', 30],
    queryFn: () => listCompletionHistory({ data: { days: 30 } }),
  })

  const allDays = Array.isArray(query.data) ? query.data : []
  const days = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return allDays
    return allDays
      .map((d) => ({
        ...d,
        items: d.items.filter((i) => i.title.toLowerCase().includes(q)),
      }))
      .filter((d) => d.items.length > 0)
      .map((d) => ({
        ...d,
        totalXp: d.items.reduce((acc, i) => acc + i.xp, 0),
      }))
  }, [allDays, search])
  const totalXp = days.reduce((acc, d) => acc + d.totalXp, 0)
  const totalItems = days.reduce((acc, d) => acc + d.items.length, 0)

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-[var(--sea-ink)]">History</h2>
          {query.isLoading ? null : (
            <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
              {totalItems} completions · {totalXp} XP · {days.length}{' '}
              active {days.length === 1 ? 'day' : 'days'}
            </p>
          )}
        </div>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search history…"
          className="field-input max-w-xs"
        />
      </header>

      {query.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : days.length === 0 ? (
        <p className="text-sm text-[var(--sea-ink-soft)]">
          {search
            ? 'Nothing matches that search.'
            : 'Nothing in the last 30 days. Go complete something.'}
        </p>
      ) : (
        <ol className="space-y-5">
          {days.map((day) => (
            <li key={day.date}>
              <header className="mb-2 flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-bold text-[var(--sea-ink)]">
                  {formatDayLabel(day.date)}
                </h3>
                <span className="text-xs font-semibold text-[var(--lagoon-deep)]">
                  +{day.totalXp} XP · {day.items.length} done
                </span>
              </header>
              <ul className="space-y-1">
                {day.items.map((item) => (
                  <li
                    key={item.instanceId}
                    className="island-shell flex items-center gap-3 rounded-xl p-3"
                  >
                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.14)] text-xs font-bold text-[var(--lagoon-deep)]">
                      ✓
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-[var(--sea-ink)]">
                        {item.title}
                      </p>
                      <p className="text-xs text-[var(--sea-ink-soft)]">
                        {formatTime(item.completedAt)} · +{item.xp} XP
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function formatDayLabel(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diff = Math.round((today.getTime() - d.getTime()) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff < 7) {
    return d.toLocaleDateString(undefined, { weekday: 'long' })
  }
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  })
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function XpLineSection({
  data,
}: {
  data: Array<{ date: string; xp: number; count: number }>
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
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">XP per day</h2>
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

function WeekdaySection({ data }: { data: number[] }) {
  const labels = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
  const full = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const max = data.reduce((a, b) => Math.max(a, b), 0) || 1
  return (
    <section className="island-shell rounded-2xl p-4">
      <header className="mb-3">
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">By weekday</h2>
      </header>
      <div className="flex items-end gap-1.5">
        {data.map((count, i) => {
          const h = Math.max(6, (count / max) * 96)
          return (
            <div
              key={i}
              className="flex min-w-0 flex-1 flex-col items-center gap-1"
              title={`${full[i]}: ${count}`}
            >
              <span className="text-[10px] font-semibold text-[var(--sea-ink-soft)]">
                {count}
              </span>
              <div
                className="w-full rounded-t-md bg-[var(--lagoon-deep)]"
                style={{ height: `${h}px` }}
              />
              <span className="text-[10px] text-[var(--sea-ink-soft)]">
                {labels[i]}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function HourSection({ data }: { data: number[] }) {
  const max = data.reduce((a, b) => Math.max(a, b), 0) || 1
  return (
    <section className="island-shell rounded-2xl p-4">
      <header className="mb-3">
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">By hour</h2>
      </header>
      <div className="flex items-end gap-0.5">
        {data.map((count, i) => {
          const h = Math.max(4, (count / max) * 96)
          const tick = i !== 0 && i % 6 === 0
          return (
            <div
              key={i}
              className="flex min-w-0 flex-1 flex-col items-center"
              title={`${i}:00 – ${count}`}
            >
              <div
                className="w-full rounded-t-sm bg-[var(--palm)]"
                style={{ height: `${h}px` }}
              />
              {/* Fixed-height label row so unlabeled columns don't sit a line lower than labeled ones. */}
              <span className="mt-1 h-3 leading-3 text-[9px] text-[var(--sea-ink-soft)]">
                {tick ? hourLabel(i) : '\u00A0'}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function hourLabel(hour: number): string {
  if (hour === 0) return 'midnight'
  if (hour === 12) return 'noon'
  if (hour < 12) return `${hour} am`
  return `${hour - 12} pm`
}

function TopTasksSection({
  tasks,
}: {
  tasks: Array<{ taskId: string | null; title: string; count: number }>
}) {
  return (
    <section className="island-shell rounded-2xl p-4">
      <header className="mb-3">
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">Top tasks</h2>
      </header>
      {tasks.length === 0 ? (
        <p className="text-sm text-[var(--sea-ink-soft)]">
          No completions in this window yet.
        </p>
      ) : (
        <ol className="space-y-2">
          {tasks.map((t, i) => (
            <li
              key={`${t.taskId}-${i}`}
              className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3"
            >
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[var(--btn-primary-bg)] text-xs font-bold text-[var(--btn-primary-fg)]">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--sea-ink)]">
                {t.title}
              </span>
              <span className="text-xs font-semibold text-[var(--sea-ink-soft)]">
                {t.count} {t.count === 1 ? 'completion' : 'completions'}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
