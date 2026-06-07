import { useEffect, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getTaskStats } from '../../../server/functions/tasks'
import { useAvailableWindows } from '../../../lib/useAvailableWindows'
import {
  TimingDistributionSection,
  XpLineSection,
} from '../../../components/stats/charts'

export const Route = createFileRoute('/_authenticated/stats/task/$taskId')({
  component: TaskStatsPage,
})

type Range = 7 | 30 | 90 | 'all'

function TaskStatsPage() {
  const { taskId } = Route.useParams()
  const [days, setDays] = useState<Range>(30)
  const { allows } = useAvailableWindows()
  const query = useQuery({
    queryKey: ['taskStats', taskId, days],
    queryFn: () => getTaskStats({ data: { taskId, days } }),
  })
  const ranges = ([7, 30, 90, 'all'] as Range[]).filter((r) => allows(r))
  useEffect(() => {
    if (!ranges.includes(days) && ranges.length > 0) {
      setDays(ranges[0])
    }
  }, [ranges.join(','), days])

  const stats = query.data

  return (
    <main className="page-wrap space-y-6 px-4 py-8">
      <header className="space-y-3">
        <Link
          to="/stats"
          className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
        >
          ← All stats
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="island-kicker mb-1">Task</p>
            <h1 className="display-title truncate text-3xl font-bold text-[var(--sea-ink)] md:text-4xl">
              {stats?.task.title ?? 'Loading…'}
            </h1>
            {stats && (
              <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
                {taskMetaLine(stats.task)}
              </p>
            )}
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
        </div>
      </header>

      {query.isLoading || !stats ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : (
        <>
          <SummaryRow
            completionCount={stats.completionCount}
            totalXp={stats.totalXp}
            timing={stats.timingOffset}
            household={!!stats.household}
          />
          {stats.household && stats.household.perPerson.length > 0 ? (
            <HouseholdBreakdownSection household={stats.household} />
          ) : null}
          <XpLineSection data={stats.xpByDay} label="XP from this task" />
          {stats.task.timeOfDay ? (
            <TimingDistributionSection
              data={
                stats.timingOffset ?? {
                  buckets: [],
                  totalScheduled: 0,
                  avgOffsetMin: 0,
                  withinThirtyCount: 0,
                }
              }
              emptyMessage="No completions in this window yet."
            />
          ) : null}
          <RecentCompletionsSection items={stats.recentCompletions} />
        </>
      )}
    </main>
  )
}

function SummaryRow({
  completionCount,
  totalXp,
  timing,
  household,
}: {
  completionCount: number
  totalXp: number
  timing: {
    totalScheduled: number
    avgOffsetMin: number
    withinThirtyCount: number
  } | null
  household: boolean
}) {
  const onTimePct =
    timing && timing.totalScheduled > 0
      ? Math.round((timing.withinThirtyCount / timing.totalScheduled) * 100)
      : null
  return (
    <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat
        label="Completions"
        value={String(completionCount)}
        hint={household ? 'household total' : undefined}
      />
      <Stat
        label="Total XP"
        value={`+${totalXp}`}
        hint={household ? 'household total' : undefined}
      />
      {timing && (
        <Stat
          label="On-time"
          value={onTimePct !== null ? `${onTimePct}%` : '—'}
          hint="within 30 min"
        />
      )}
      {timing && (
        <Stat
          label="Avg offset"
          value={offsetLabel(timing.avgOffsetMin)}
        />
      )}
    </section>
  )
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="island-shell rounded-2xl p-4">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
        {label}
      </p>
      <p className="mt-1 text-xl font-bold text-[var(--sea-ink)]">{value}</p>
      {hint && (
        <p className="mt-0.5 text-[10px] text-[var(--sea-ink-soft)]">{hint}</p>
      )}
    </div>
  )
}

function RecentCompletionsSection({
  items,
}: {
  items: Array<{
    instanceId: string | null
    occurredAt: string
    xp: number
    by: { name: string; color: string | null } | null
  }>
}) {
  if (items.length === 0) {
    return (
      <section className="island-shell rounded-2xl p-4">
        <header className="mb-3">
          <h2 className="text-sm font-bold text-[var(--sea-ink)]">
            Recent completions
          </h2>
        </header>
        <p className="text-sm text-[var(--sea-ink-soft)]">
          No completions in this window yet.
        </p>
      </section>
    )
  }
  return (
    <section className="island-shell rounded-2xl p-4">
      <header className="mb-3">
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">
          Recent completions
        </h2>
      </header>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li
            key={item.instanceId ?? `${item.occurredAt}-${i}`}
            className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3"
          >
            <span
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold"
              style={
                item.by
                  ? {
                      borderColor: item.by.color ?? 'var(--lagoon-deep)',
                      color: item.by.color ?? 'var(--lagoon-deep)',
                      backgroundColor: 'var(--option-bg)',
                    }
                  : {
                      borderColor: 'var(--lagoon-deep)',
                      color: 'var(--lagoon-deep)',
                      backgroundColor: 'rgba(79,184,178,0.14)',
                    }
              }
            >
              ✓
            </span>
            <div className="min-w-0 flex-1">
              {item.by ? (
                <p className="truncate text-sm font-semibold text-[var(--sea-ink)]">
                  {item.by.name}
                </p>
              ) : null}
              <p
                className={
                  item.by
                    ? 'text-xs text-[var(--sea-ink-soft)]'
                    : 'text-sm text-[var(--sea-ink)]'
                }
              >
                {formatDateTime(item.occurredAt)}
              </p>
            </div>
            <span className="text-xs font-semibold text-[var(--lagoon-deep)]">
              +{item.xp} XP
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

type Household = NonNullable<
  Awaited<ReturnType<typeof getTaskStats>>['household']
>

function HouseholdBreakdownSection({ household }: { household: Household }) {
  const total = household.perPerson.reduce((s, p) => s + p.completions, 0)
  return (
    <section className="island-shell rounded-2xl p-4">
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold text-[var(--sea-ink)]">By person</h2>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
          {household.rotation === 'round_robin' ? 'Rotating' : 'Shared'}
        </span>
      </header>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {household.perPerson.map((p) => {
          const share = total > 0 ? Math.round((p.completions / total) * 100) : 0
          return (
            <div
              key={p.userId}
              className="rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3"
            >
              <div className="mb-2 flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: p.color ?? 'var(--lagoon-deep)' }}
                />
                <span className="truncate text-sm font-semibold text-[var(--sea-ink)]">
                  {p.name}
                </span>
              </div>
              <p className="text-lg font-bold text-[var(--sea-ink)]">
                {p.completions}
                <span className="ml-1 text-xs font-semibold text-[var(--sea-ink-soft)]">
                  ({share}%)
                </span>
              </p>
              <p className="mt-1 text-[11px] text-[var(--sea-ink-soft)]">
                {p.onTimePct !== null ? `${p.onTimePct}% on-time` : 'no due dates'}
                {' · '}+{p.xp} XP
              </p>
              {p.lastCompletedAt ? (
                <p className="mt-0.5 text-[11px] text-[var(--sea-ink-soft)]">
                  last {formatDateTime(p.lastCompletedAt)}
                </p>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function taskMetaLine(task: {
  timeOfDay: string | null
  difficulty: string | null
  recurrence: string | null
  categorySlug: string | null
  exists: boolean
}): string {
  const parts: string[] = []
  if (task.timeOfDay) parts.push(`Scheduled ${formatTimeOfDay(task.timeOfDay)}`)
  if (task.recurrence) parts.push(task.recurrence)
  if (task.difficulty) parts.push(task.difficulty)
  if (task.categorySlug) parts.push(task.categorySlug)
  if (!task.exists) parts.push('deleted')
  return parts.length > 0 ? parts.join(' · ') : 'Task details'
}

function formatTimeOfDay(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':')
  const h = Number.parseInt(hStr ?? '', 10)
  const m = Number.parseInt(mStr ?? '', 10)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function offsetLabel(min: number): string {
  if (min === 0) return 'on time'
  const abs = Math.abs(min)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  const mag = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`
  return min > 0 ? `${mag} late` : `${mag} early`
}
