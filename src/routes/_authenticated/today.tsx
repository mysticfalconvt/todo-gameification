import { useEffect, useState } from 'react'
import { Link, createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  completeInstance,
  getProgression,
  listSomedayInstances,
  listTodayInstances,
  skipInstance,
  snoozeInstance,
} from '../../server/functions/tasks'
import {
  currentPushStatus,
  disablePushNotifications,
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
        <div>
          <p className="island-kicker mb-1">Today</p>
          <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
            {instances.length > 0
              ? `${instances.length} to knock out`
              : 'All clear'}
          </h1>
        </div>
        <Link
          to="/tasks/new"
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-sm font-semibold text-[var(--lagoon-deep)] no-underline"
        >
          + New
        </Link>
      </header>

      {progression ? (
        <section className="island-shell mb-6 grid grid-cols-3 gap-4 rounded-2xl p-4 text-center">
          <Stat label="Level" value={progression.level} />
          <Stat label="XP" value={progression.xp} />
          <Stat label="Streak" value={`${progression.currentStreak}d`} />
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

  useEffect(() => {
    let cancelled = false
    currentPushStatus().then((s) => {
      if (!cancelled) setStatus(s)
    })
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

  async function onDisable() {
    setWorking(true)
    setError(null)
    try {
      await disablePushNotifications()
      setStatus('unknown')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disable')
    } finally {
      setWorking(false)
    }
  }

  if (status === 'unsupported') return null
  if (status === 'enabled') {
    return (
      <div className="island-shell mb-6 flex items-center justify-between gap-3 rounded-xl p-3 text-sm">
        <span className="text-[var(--sea-ink-soft)]">
          Notifications on for this device.
        </span>
        <button
          type="button"
          onClick={onDisable}
          disabled={working}
          className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] disabled:opacity-60"
        >
          Turn off
        </button>
      </div>
    )
  }
  return (
    <div className="island-shell mb-6 flex flex-col gap-2 rounded-xl p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <span className="text-[var(--sea-ink-soft)]">
        Get a push when tasks are due.
      </span>
      <div className="flex items-center gap-3">
        {error ? <span className="text-xs text-red-600">{error}</span> : null}
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
