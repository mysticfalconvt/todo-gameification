import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getStats, listCompletionHistory } from '../../../server/functions/tasks'
import { getMotivationStats } from '../../../server/functions/motivation'
import { useAvailableWindows } from '../../../lib/useAvailableWindows'
import {
  TimingDistributionSection,
  XpLineSection,
} from '../../../components/stats/charts'

export const Route = createFileRoute('/_authenticated/stats/')({
  component: StatsPage,
})

type Range = 7 | 30 | 90 | 'all'

function StatsPage() {
  const [days, setDays] = useState<Range>(30)
  const { allows } = useAvailableWindows()
  const query = useQuery({
    queryKey: ['stats', days],
    queryFn: () => getStats({ data: { days } }),
  })
  const ranges = ([7, 30, 90, 'all'] as Range[]).filter((r) => allows(r))
  // Collapse to the nearest allowed range when the selected one vanishes
  // (e.g., default 30 but user only has 10 days of history).
  useEffect(() => {
    if (!ranges.includes(days) && ranges.length > 0) {
      setDays(ranges[0])
    }
  }, [ranges.join(','), days])

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
          {ranges.map((r) => (
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
          <TimingDistributionSection
            data={
              stats.timingOffset ?? {
                buckets: [],
                totalScheduled: 0,
                avgOffsetMin: 0,
                withinThirtyCount: 0,
              }
            }
          />
          <TopTasksSection tasks={stats.topTasks} />
          <MotivationSection days={days} />
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
                {day.items.map((item) => {
                  const rowClass =
                    'island-shell flex items-center gap-3 rounded-xl p-3'
                  const body = (
                    <>
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
                    </>
                  )
                  return (
                    <li key={item.instanceId}>
                      {item.taskId ? (
                        <Link
                          to="/stats/task/$taskId"
                          params={{ taskId: item.taskId }}
                          className={`${rowClass} transition hover:border-[var(--lagoon-deep)]`}
                        >
                          {body}
                        </Link>
                      ) : (
                        <div className={rowClass}>{body}</div>
                      )}
                    </li>
                  )
                })}
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

function MotivationSection({ days }: { days: Range }) {
  const query = useQuery({
    queryKey: ['motivation-stats', days],
    queryFn: () => getMotivationStats({ data: { days } }),
  })
  const data = query.data
  if (query.isLoading || !data) {
    return (
      <section className="island-shell rounded-2xl p-4">
        <p className="text-sm text-[var(--sea-ink-soft)]">Loading focus & games…</p>
      </section>
    )
  }

  const totalGamesPlayed = data.games.reduce((acc, g) => acc + g.played, 0)
  const totalGameXp = data.games.reduce((acc, g) => acc + g.xpEarned, 0)
  const completionRate =
    data.focus.started > 0
      ? Math.round((data.focus.completed / data.focus.started) * 100)
      : null

  return (
    <section className="space-y-4">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold text-[var(--sea-ink)]">Focus & games</h2>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatCard
          label="Focus minutes"
          value={data.focus.minutesCompleted}
          hint={`${data.focus.completed} completed`}
        />
        <StatCard
          label="Completion rate"
          value={completionRate != null ? `${completionRate}%` : '—'}
          hint={`${data.focus.started} started`}
        />
        <StatCard
          label="XP from focus"
          value={data.focus.xpEarned}
          hint={`🪙 ${data.focus.tokensEarned} earned`}
        />
        <StatCard
          label="XP from games"
          value={totalGameXp}
          hint={`${totalGamesPlayed} played`}
        />
      </div>

      {data.games.length > 0 ? (
        <div className="island-shell overflow-x-auto rounded-2xl">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-[var(--line)] bg-[var(--option-bg)] text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
              <tr>
                <th className="px-3 py-2">Game</th>
                <th className="px-3 py-2">Played</th>
                <th className="px-3 py-2">Won</th>
                <th className="px-3 py-2">Win rate</th>
                <th className="px-3 py-2">XP earned</th>
              </tr>
            </thead>
            <tbody>
              {data.games.map((g) => {
                const rate = g.played > 0 ? Math.round((g.won / g.played) * 100) : 0
                return (
                  <tr
                    key={g.gameId}
                    className="border-b border-[var(--line)] last:border-none"
                  >
                    <td className="px-3 py-2 font-semibold text-[var(--sea-ink)]">
                      {g.name}
                    </td>
                    <td className="px-3 py-2">{g.played}</td>
                    <td className="px-3 py-2">{g.won}</td>
                    <td className="px-3 py-2 text-[var(--sea-ink-soft)]">
                      {rate}%
                    </td>
                    <td className="px-3 py-2">{g.xpEarned}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {data.recentEvents.length > 0 ? (
        <details className="island-shell rounded-2xl p-4">
          <summary className="cursor-pointer text-sm font-semibold text-[var(--sea-ink)]">
            Recent activity ({data.recentEvents.length})
          </summary>
          <ul className="mt-3 space-y-1 text-sm">
            {data.recentEvents.map((e) => (
              <li
                key={e.id}
                className="flex flex-wrap items-baseline gap-2 rounded-lg border border-[var(--line)] bg-[var(--option-bg)] p-2 text-xs"
              >
                <span className="text-[var(--sea-ink-soft)]">
                  {formatTime(e.occurredAt)} ·{' '}
                  {formatDayLabel(e.occurredAt.slice(0, 10))}
                </span>
                <MotivationRow event={e} />
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p className="text-sm text-[var(--sea-ink-soft)]">
          No focus sessions or games yet in this window.{' '}
          <Link to="/focus" className="underline">
            Start one
          </Link>
          .
        </p>
      )}
    </section>
  )
}

type MotivationEvent = NonNullable<
  Awaited<ReturnType<typeof getMotivationStats>>
>['recentEvents'][number]

function MotivationRow({ event }: { event: MotivationEvent }) {
  if (event.type === 'focus.started') {
    return (
      <span className="text-[var(--sea-ink)]">
        🎯 Started {event.durationMin ?? '?'}-min focus session
      </span>
    )
  }
  if (event.type === 'focus.completed') {
    return (
      <span className="text-[var(--sea-ink)]">
        ✅ Finished {event.durationMin ?? '?'}-min session · +{event.xpEarned} XP
        · +{event.tokensEarned} 🪙
      </span>
    )
  }
  // game.played
  return (
    <span className="text-[var(--sea-ink)]">
      🎮 {event.gameName} · {event.won ? 'won' : 'played'} · −{event.tokenCost} 🪙
      {event.xpReward > 0 ? ` · +${event.xpReward} XP` : ''}
    </span>
  )
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string
  value: number | string
  hint?: string
}) {
  return (
    <div className="island-shell rounded-2xl p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold text-[var(--sea-ink)]">
        {value}
      </div>
      {hint ? (
        <div className="mt-1 text-xs text-[var(--sea-ink-soft)]">{hint}</div>
      ) : null}
    </div>
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
          {tasks.map((t, i) => {
            const rowClass =
              'flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3'
            const body = (
              <>
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[var(--btn-primary-bg)] text-xs font-bold text-[var(--btn-primary-fg)]">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--sea-ink)]">
                  {t.title}
                </span>
                <span className="text-xs font-semibold text-[var(--sea-ink-soft)]">
                  {t.count} {t.count === 1 ? 'completion' : 'completions'}
                </span>
              </>
            )
            return (
              <li key={`${t.taskId}-${i}`}>
                {t.taskId ? (
                  <Link
                    to="/stats/task/$taskId"
                    params={{ taskId: t.taskId }}
                    className={`${rowClass} transition hover:border-[var(--lagoon-deep)]`}
                  >
                    {body}
                  </Link>
                ) : (
                  <div className={rowClass}>{body}</div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
