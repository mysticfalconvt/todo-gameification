import { useEffect, useMemo, useState } from 'react'
import { Link, createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  completeInstance,
  getProgression,
  listRecentActivity,
  listSomedayInstances,
  listTodayInstances,
  skipInstance,
  snoozeInstance,
} from '../../server/functions/tasks'
import { getCoachSummary } from '../../server/functions/coach'
import {
  currentPushStatus,
  enablePushNotifications,
  type PushSupportStatus,
} from '../../lib/push'
import { xpLabel } from '../../lib/xp-label'

interface TodaySearch {
  complete?: string
  snooze?: string
}

export const Route = createFileRoute('/_authenticated/today')({
  component: TodayPage,
  validateSearch: (s: Record<string, unknown>): TodaySearch => ({
    complete: typeof s.complete === 'string' ? s.complete : undefined,
    snooze: typeof s.snooze === 'string' ? s.snooze : undefined,
  }),
})

type TodayInstance = Awaited<ReturnType<typeof listTodayInstances>>[number]
type SomedayInstance = Awaited<ReturnType<typeof listSomedayInstances>>[number]

function TodayPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const search = useSearch({ from: '/_authenticated/today' })

  const todayQuery = useQuery({
    queryKey: ['today'],
    queryFn: () => listTodayInstances(),
  })

  const somedayQuery = useQuery({
    queryKey: ['someday'],
    queryFn: () => listSomedayInstances(),
  })

  const progressionQuery = useQuery({
    queryKey: ['progression'],
    queryFn: () => getProgression(),
  })

  const activityQuery = useQuery({
    queryKey: ['recent-activity'],
    queryFn: () => listRecentActivity(),
  })

  function optimisticRemove(instanceId: string) {
    return async () => {
      await qc.cancelQueries({ queryKey: ['today'] })
      await qc.cancelQueries({ queryKey: ['someday'] })
      const prevToday = qc.getQueryData<TodayInstance[]>(['today'])
      const prevSomeday = qc.getQueryData<SomedayInstance[]>(['someday'])
      qc.setQueryData<TodayInstance[]>(['today'], (old) =>
        old?.filter((i) => i.instanceId !== instanceId),
      )
      qc.setQueryData<SomedayInstance[]>(['someday'], (old) =>
        old?.filter((i) => i.instanceId !== instanceId),
      )
      return { prevToday, prevSomeday }
    }
  }

  const complete = useMutation({
    mutationFn: (instanceId: string) =>
      completeInstance({ data: { instanceId } }),
    onMutate: (instanceId) => optimisticRemove(instanceId)(),
    onError: (_err, _id, ctx) => {
      if (ctx?.prevToday) qc.setQueryData(['today'], ctx.prevToday)
      if (ctx?.prevSomeday) qc.setQueryData(['someday'], ctx.prevSomeday)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['today'] })
      qc.invalidateQueries({ queryKey: ['someday'] })
      qc.invalidateQueries({ queryKey: ['progression'] })
      qc.invalidateQueries({ queryKey: ['recent-activity'] })
    },
  })

  const skip = useMutation({
    mutationFn: (instanceId: string) => skipInstance({ data: { instanceId } }),
    onMutate: (instanceId) => optimisticRemove(instanceId)(),
    onError: (_err, _id, ctx) => {
      if (ctx?.prevToday) qc.setQueryData(['today'], ctx.prevToday)
      if (ctx?.prevSomeday) qc.setQueryData(['someday'], ctx.prevSomeday)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['today'] })
      qc.invalidateQueries({ queryKey: ['someday'] })
    },
  })

  const snooze = useMutation({
    mutationFn: ({ instanceId, hours }: { instanceId: string; hours: number }) =>
      snoozeInstance({ data: { instanceId, hours } }),
    onMutate: ({ instanceId }) => optimisticRemove(instanceId)(),
    onError: (_err, _vars, ctx) => {
      if (ctx?.prevToday) qc.setQueryData(['today'], ctx.prevToday)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['today'] }),
  })

  // Auto-handle actions from notification taps: /today?complete=<id> or ?snooze=<id>
  useEffect(() => {
    if (search.complete) {
      complete.mutate(search.complete)
      navigate({ to: '/today', replace: true, search: {} })
    } else if (search.snooze) {
      snooze.mutate({ instanceId: search.snooze, hours: 1 })
      navigate({ to: '/today', replace: true, search: {} })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.complete, search.snooze])

  const instances = todayQuery.data ?? []
  const somedayInstances = somedayQuery.data ?? []
  const progression = progressionQuery.data

  return (
    <main className="page-wrap px-4 py-8">
      <header className="mb-6 flex items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="island-kicker mb-1">Today</p>
          <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
            {instances.length > 0
              ? `${instances.length} to knock out`
              : 'All clear'}
          </h1>
          <CoachBlurb
            instances={instances}
            progression={progression}
          />
        </div>
        <Link
          to="/tasks/new"
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] no-underline"
        >
          + New
        </Link>
      </header>

      {progression ? (
        <section className="island-shell mb-6 rounded-2xl p-4">
          <div className="grid grid-cols-4 gap-4 text-center">
            <Stat label="Level" value={progression.level} />
            <Stat label="XP" value={progression.xp} />
            <Stat label="Streak" value={`${progression.currentStreak}d`} />
            <Stat label="Longest" value={`${progression.longestStreak}d`} />
          </div>
          <div className="mt-4">
            <ActivityStrip days={activityQuery.data ?? []} />
          </div>
        </section>
      ) : null}

      <PushBanner />

      {todayQuery.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : instances.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">
          Nothing due today. Treat yourself to a break.
        </p>
      ) : (
        <ul className="space-y-2">
          {instances.map((inst) => (
            <li
              key={inst.instanceId}
              className="island-shell flex items-center gap-3 rounded-xl p-3"
            >
              <button
                type="button"
                aria-label={`Complete ${inst.title}`}
                onClick={() => complete.mutate(inst.instanceId)}
                className="h-6 w-6 flex-shrink-0 rounded-full border-2 border-[rgba(50,143,151,0.4)] transition hover:border-[var(--lagoon-deep)] hover:bg-[rgba(79,184,178,0.16)]"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-[var(--sea-ink)]">
                  {inst.title}
                </p>
                <p className="text-xs text-[var(--sea-ink-soft)]">
                  {dueLabel(inst.dueAt, inst.timeOfDay)}
                  {' • '}
                  {xpLabel(inst.difficulty, inst.xpOverride)}
                </p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                <IconButton
                  label={`Snooze ${inst.title} for 1 hour`}
                  onClick={() => snooze.mutate({ instanceId: inst.instanceId, hours: 1 })}
                >
                  ⏰ 1h
                </IconButton>
                <IconButton
                  label={`Skip ${inst.title}`}
                  onClick={() => skip.mutate(inst.instanceId)}
                >
                  ⏭ Skip
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      {somedayInstances.length > 0 ? (
        <section className="mt-10">
          <header className="mb-3 flex items-baseline justify-between">
            <h2 className="display-title text-xl font-bold text-[var(--sea-ink)]">
              Someday
            </h2>
            <span className="text-xs text-[var(--sea-ink-soft)]">
              {somedayInstances.length} {somedayInstances.length === 1 ? 'item' : 'items'}
            </span>
          </header>
          <ul className="space-y-2">
            {somedayInstances.map((inst) => (
              <li
                key={inst.instanceId}
                className="island-shell flex items-center gap-3 rounded-xl p-3"
              >
                <button
                  type="button"
                  aria-label={`Complete ${inst.title}`}
                  onClick={() => complete.mutate(inst.instanceId)}
                  className="h-6 w-6 flex-shrink-0 rounded-full border-2 border-[rgba(50,143,151,0.4)] transition hover:border-[var(--lagoon-deep)] hover:bg-[rgba(79,184,178,0.16)]"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-[var(--sea-ink)]">
                    {inst.title}
                  </p>
                  <p className="text-xs text-[var(--sea-ink-soft)]">
                    {xpLabel(inst.difficulty, inst.xpOverride)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  )
}

function PushBanner() {
  const [status, setStatus] = useState<PushSupportStatus>('unknown')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    currentPushStatus().then((s) => {
      if (!cancelled) setStatus(s)
    })
    if (typeof localStorage !== 'undefined') {
      setDismissed(localStorage.getItem(PUSH_DISMISS_KEY) === '1')
    }
    return () => {
      cancelled = true
    }
  }, [])

  async function onEnable() {
    setWorking(true)
    setError(null)
    try {
      await enablePushNotifications()
      setStatus('enabled')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to enable')
    } finally {
      setWorking(false)
    }
  }

  function onHide() {
    localStorage.setItem(PUSH_DISMISS_KEY, '1')
    setDismissed(true)
  }

  if (status === 'unsupported') return null
  // When notifications are on, the disable/toggle lives on /settings so this
  // surface stays focused on the work. Only show the prompt when they're off.
  if (status === 'enabled') return null
  if (dismissed) return null
  return (
    <div className="island-shell mb-6 flex flex-col gap-2 rounded-xl p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <span className="text-[var(--sea-ink-soft)]">
        Get a push when tasks are due. You can always enable this from your
        profile later.
      </span>
      <div className="flex items-center gap-2">
        {error ? <span className="text-xs text-red-600">{error}</span> : null}
        <button
          type="button"
          onClick={onHide}
          className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)]"
        >
          Hide
        </button>
        <button
          type="button"
          onClick={onEnable}
          disabled={working}
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-3 py-1 text-xs font-semibold text-[var(--lagoon-deep)] disabled:opacity-60"
        >
          {working ? 'Enabling…' : 'Enable notifications'}
        </button>
      </div>
    </div>
  )
}

const PUSH_DISMISS_KEY = 'todo-xp-push-prompt-dismissed'

function CoachBlurb({
  instances,
  progression,
}: {
  instances: TodayInstance[]
  progression:
    | { xp: number; currentStreak: number; longestStreak: number }
    | undefined
}) {
  // A signature derived from the state the coach cares about. When it
  // changes, the React Query key changes, so Query auto-fetches fresh copy.
  //
  // Included in the sig:
  //  - open instance IDs (sorted) → completes / skips / snoozes / adds all flip this
  //  - xp → any completion bumps this
  //  - current streak → day rollovers flip this
  //  - hour bucket (every 2h) → covers idle users via refetchInterval too
  const signature = useMemo(() => {
    const ids = instances
      .map((i) => i.instanceId)
      .sort()
      .join(',')
    const xp = progression?.xp ?? 0
    const streak = progression?.currentStreak ?? 0
    const hourBucket = Math.floor(Date.now() / (2 * 3_600_000))
    return `${ids}|${xp}|${streak}|${hourBucket}`
  }, [instances, progression?.xp, progression?.currentStreak])

  const query = useQuery({
    queryKey: ['coach', signature],
    queryFn: () => getCoachSummary(),
    // The key already encodes the freshness we care about, so keep each
    // fetched summary around indefinitely (until its key is gc'd). A 2-hour
    // refetchInterval covers the idle-user case.
    staleTime: Infinity,
    gcTime: 1000 * 60 * 60 * 4,
    refetchInterval: 1000 * 60 * 60 * 2,
    refetchOnWindowFocus: false,
  })

  if (query.isLoading) {
    return (
      <div className="mt-2 h-4 w-3/4 max-w-md animate-pulse rounded bg-[var(--option-bg)]" />
    )
  }
  if (!query.data) return null
  return (
    <p className="mt-2 max-w-2xl text-sm italic text-[var(--sea-ink-soft)]">
      {query.data.summary}
    </p>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[var(--kicker)]">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold text-[var(--sea-ink)]">{value}</p>
    </div>
  )
}

function ActivityStrip({ days }: { days: string[] }) {
  const done = new Set(days)
  const dayKey = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d)
  const cells = Array.from({ length: 7 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - (6 - i))
    return {
      key: dayKey(d),
      label: d.toLocaleDateString(undefined, { weekday: 'narrow' }),
      done: done.has(dayKey(d)),
      isToday: i === 6,
    }
  })
  return (
    <div>
      <p className="mb-2 text-xs uppercase tracking-wide text-[var(--kicker)]">
        Last 7 days
      </p>
      <div className="flex items-end gap-1.5">
        {cells.map((c) => (
          <div key={c.key} className="flex flex-1 flex-col items-center gap-1">
            <span
              className={`h-6 w-full rounded-md ${
                c.done
                  ? 'bg-[var(--lagoon-deep)]'
                  : 'bg-[var(--option-bg)] border border-[var(--line)]'
              } ${c.isToday ? 'ring-2 ring-[var(--lagoon)]' : ''}`}
              aria-label={`${c.key}: ${c.done ? 'completed' : 'no completions'}`}
            />
            <span className="text-[10px] text-[var(--sea-ink-soft)]">
              {c.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-2.5 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] transition hover:text-[var(--sea-ink)]"
    >
      {children}
    </button>
  )
}

function dueLabel(dueAt: string, timeOfDay: string | null): string {
  const d = new Date(dueAt)
  const now = new Date()
  const dayMs = 86_400_000
  const label =
    d.toDateString() === now.toDateString()
      ? 'Today'
      : d.getTime() - now.getTime() < dayMs
        ? 'Today'
        : d.getTime() - now.getTime() < 2 * dayMs
          ? 'Tomorrow'
          : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  if (!timeOfDay) return `${label} (anytime)`
  const hhmm = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  return `${label} ${hhmm}`
}
