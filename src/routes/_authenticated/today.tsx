import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  getProgression,
  listRecentActivity,
  listSomedayInstances,
  listTodayInstances,
} from '../../server/functions/tasks'
import { listCategories } from '../../server/functions/categories'
import { getCoachSummary } from '../../server/functions/coach'
import { getProfile } from '../../server/functions/user'
import type { GardenView } from '../../server/services/garden'
import { runOrQueue } from '../../lib/offline-queue'
import {
  currentPushStatus,
  enablePushNotifications,
  type PushSupportStatus,
} from '../../lib/push'
import { xpLabel } from '../../lib/xp-label'
import { SortSelect } from '../../components/SortSelect'
import {
  TaskDetailsDialog,
  type TaskDetailsInstance,
} from '../../components/TaskDetailsDialog'
import { TODAY_SORTS, compareBy, useStoredSort } from '../../lib/sort'
import {
  DAY_PART_LABEL,
  TIMED_DAY_PARTS,
  currentDayPart,
  isBucketCurrentOrPast,
  partForTimeOfDay,
  type DayPart,
} from '../../domain/dayParts'

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

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => listCategories(),
  })
  // Cheap to query — already cached from settings if the user's been there.
  // Used here only to decide whether to stack the header on mobile when
  // the coach is in detailed (longer) mode.
  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: () => getProfile(),
  })
  const coachDetailed = profileQuery.data?.coachDetailed ?? false
  const catBySlug = useMemo(() => {
    const m = new Map<string, { label: string; color: string }>()
    // Defensive: a stale or corrupted persisted query entry could come
    // back as something non-iterable. Fall back to an empty map instead
    // of crashing the whole TodayPage.
    const raw = categoriesQuery.data
    const list = Array.isArray(raw) ? raw : []
    for (const c of list) {
      m.set(c.slug, { label: c.label, color: c.color })
    }
    return m
  }, [categoriesQuery.data])

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

  // Detects "this completion is the first watering today for that
  // plant's category" by peeking at the cached garden + today list.
  // Runs entirely client-side so the toast fires instantly without
  // waiting for a round-trip. Returns the plant's human label so the
  // toast can name the category.
  function firstWateringInfo(instanceId: string): {
    first: boolean
    label: string
  } {
    const instance =
      (qc.getQueryData<TodayInstance[]>(['today']) ?? []).find(
        (i) => i.instanceId === instanceId,
      ) ??
      (qc.getQueryData<SomedayInstance[]>(['someday']) ?? []).find(
        (i) => i.instanceId === instanceId,
      )
    const categorySlug = instance?.categorySlug ?? null
    const garden = qc.getQueryData<GardenView>(['garden'])
    const plant = garden?.plants.find(
      (p) => p.categorySlug === categorySlug,
    )
    const label =
      plant?.label ??
      (categorySlug ? catBySlug.get(categorySlug)?.label : null) ??
      'Uncategorized'
    const todayLocal = new Date().toLocaleDateString()
    const lastLocal = plant?.lastWateredAt
      ? new Date(plant.lastWateredAt).toLocaleDateString()
      : null
    return { first: lastLocal !== todayLocal, label }
  }

  const complete = useMutation({
    mutationFn: ({
      instanceId,
      force,
    }: {
      instanceId: string
      force?: boolean
    }) => runOrQueue({ type: 'complete', instanceId, force: force ?? true }),
    onMutate: async ({ instanceId }) => {
      const watering = firstWateringInfo(instanceId)
      const removed = await optimisticRemove(instanceId)()
      return { ...removed, watering }
    },
    onSuccess: (_data, _vars, ctx) => {
      if (ctx?.watering.first) {
        toast.success(
          `🌱 First watering today — ${ctx.watering.label} is perky.`,
        )
      }
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prevToday) qc.setQueryData(['today'], ctx.prevToday)
      if (ctx?.prevSomeday) qc.setQueryData(['someday'], ctx.prevSomeday)
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['today'] })
      qc.invalidateQueries({ queryKey: ['someday'] })
      qc.invalidateQueries({ queryKey: ['progression'] })
      qc.invalidateQueries({ queryKey: ['recent-activity'] })
      qc.invalidateQueries({ queryKey: ['garden'] })
    },
  })

  // When the user checks off a parent task that still has unchecked
  // steps, hold the click in this state and surface a confirm modal
  // instead of completing immediately. Clearing dismisses the modal.
  const [pendingComplete, setPendingComplete] = useState<{
    instanceId: string
    title: string
    unchecked: number
  } | null>(null)

  function handleComplete(inst: {
    instanceId: string
    title: string
    stepsTotal: number
    stepsCompleted: number
  }): void {
    const unchecked = inst.stepsTotal - inst.stepsCompleted
    if (inst.stepsTotal > 0 && unchecked > 0) {
      setPendingComplete({
        instanceId: inst.instanceId,
        title: inst.title,
        unchecked,
      })
      return
    }
    complete.mutate({ instanceId: inst.instanceId })
  }

  const skip = useMutation({
    mutationFn: (instanceId: string) =>
      runOrQueue({ type: 'skip', instanceId }),
    onMutate: (instanceId) => optimisticRemove(instanceId)(),
    onError: (err, _id, ctx) => {
      if (ctx?.prevToday) qc.setQueryData(['today'], ctx.prevToday)
      if (ctx?.prevSomeday) qc.setQueryData(['someday'], ctx.prevSomeday)
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['today'] })
      qc.invalidateQueries({ queryKey: ['someday'] })
    },
  })

  const snooze = useMutation({
    mutationFn: ({ instanceId, hours }: { instanceId: string; hours: number }) =>
      runOrQueue({ type: 'snooze', instanceId, hours }),
    onMutate: ({ instanceId }) => optimisticRemove(instanceId)(),
    onError: (err, _vars, ctx) => {
      if (ctx?.prevToday) qc.setQueryData(['today'], ctx.prevToday)
      toast.error(err instanceof Error ? err.message : 'Snooze failed')
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['today'] }),
  })

  // Auto-handle actions from notification taps: /today?complete=<id> or ?snooze=<id>
  useEffect(() => {
    if (search.complete) {
      // Notification action: skip the unchecked-steps confirm. The user
      // already decided "done" by tapping the action.
      complete.mutate({ instanceId: search.complete, force: true })
      navigate({ to: '/today', replace: true, search: {} })
    } else if (search.snooze) {
      snooze.mutate({ instanceId: search.snooze, hours: 1 })
      navigate({ to: '/today', replace: true, search: {} })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.complete, search.snooze])

  const rawInstances = Array.isArray(todayQuery.data) ? todayQuery.data : []
  const somedayInstances = Array.isArray(somedayQuery.data) ? somedayQuery.data : []
  const progression = progressionQuery.data
  const [sortKey, setSortKey] = useStoredSort(
    'todo-xp-sort-today',
    TODAY_SORTS,
    'due-asc',
  )
  const instances = useMemo(
    () => [...rawInstances].sort(compareBy(sortKey)),
    [rawInstances, sortKey],
  )

  const [selected, setSelected] = useState<TaskDetailsInstance | null>(null)

  return (
    <main className="page-wrap px-4 py-8">
      <header
        className={`mb-6 flex justify-between gap-3 ${
          coachDetailed
            ? 'flex-col items-stretch sm:flex-row sm:items-end'
            : 'items-end'
        }`}
      >
        <div className="min-w-0 flex-1">
          <p className="island-kicker mb-1">Today</p>
          <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
            {instances.length > 0
              ? `${instances.length} to knock out`
              : 'All clear'}
          </h1>
          <CoachBlurb instances={instances} />
        </div>
        <div
          className={
            coachDetailed
              ? 'flex flex-row gap-2 sm:flex-col sm:items-end'
              : 'flex flex-col items-end gap-2'
          }
        >
          <Link
            to="/tasks/new"
            className="flex-1 rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-center text-sm font-semibold text-[var(--lagoon-deep)] no-underline sm:flex-none"
          >
            + New
          </Link>
          <Link
            to="/focus"
            className="flex-1 rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-2 text-center text-sm font-semibold text-[var(--lagoon-deep)] no-underline sm:flex-none"
          >
            🎯 Focus
          </Link>
        </div>
      </header>

      {progression ? (
        <section className="island-shell mb-6 rounded-2xl p-4">
          <div className="grid grid-cols-5 gap-2 text-center">
            <Stat label="Level" value={progression.level} />
            <Stat label="XP" value={progression.xp} />
            <Stat label="Streak" value={`${progression.currentStreak}d`} />
            <Stat label="Longest" value={`${progression.longestStreak}d`} />
            <Link
              to="/arcade"
              className="flex flex-col items-center justify-center no-underline"
              aria-label={`Tokens: ${progression.tokens}. Open arcade.`}
            >
              <span className="text-lg font-semibold text-[var(--sea-ink)]">
                🪙 {progression.tokens}
              </span>
              <span className="text-[10px] uppercase tracking-wide text-[var(--sea-ink-soft)]">
                Arcade
              </span>
            </Link>
          </div>
          <div className="mt-4">
            <ActivityStrip days={Array.isArray(activityQuery.data) ? activityQuery.data : []} />
          </div>
        </section>
      ) : null}

      <PushBanner />

      {instances.length > 0 ? (
        <div className="mb-3 flex items-center justify-end">
          <SortSelect
            value={sortKey}
            options={TODAY_SORTS}
            onChange={setSortKey}
          />
        </div>
      ) : null}

      {todayQuery.isLoading ? (
        <p className="text-[var(--sea-ink-soft)]">Loading…</p>
      ) : instances.length === 0 ? (
        <p className="text-[var(--sea-ink-soft)]">
          Nothing due today. Treat yourself to a break.
        </p>
      ) : (
        <TodayBuckets
          instances={instances}
          catBySlug={catBySlug}
          onComplete={handleComplete}
          onSnooze={(id) =>
            snooze.mutate({ instanceId: id, hours: 1 })
          }
          onSkip={(id) => skip.mutate(id)}
          onSelect={setSelected}
        />
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
                  onClick={() => handleComplete(inst)}
                  className="h-6 w-6 flex-shrink-0 rounded-full border-2 border-[rgba(50,143,151,0.4)] transition hover:border-[var(--lagoon-deep)] hover:bg-[rgba(79,184,178,0.16)]"
                />
                <button
                  type="button"
                  onClick={() =>
                    setSelected({
                      taskId: inst.taskId,
                      instanceId: inst.instanceId,
                      title: inst.title,
                      difficulty: inst.difficulty,
                      xpOverride: inst.xpOverride,
                      categorySlug: inst.categorySlug,
                      dueAt: null,
                      timeOfDay: null,
                    })
                  }
                  className="min-w-0 flex-1 cursor-pointer bg-transparent p-0 text-left"
                  aria-label={`View ${inst.title}`}
                >
                  <p className="flex items-center gap-1.5 font-semibold text-[var(--sea-ink)]">
                    <CategoryDot slug={inst.categorySlug} map={catBySlug} />
                    <span className="truncate">{inst.title}</span>
                    {inst.stepsTotal > 0 ? (
                      <StepsBadge
                        completed={inst.stepsCompleted}
                        total={inst.stepsTotal}
                      />
                    ) : null}
                  </p>
                  <p className="text-xs text-[var(--sea-ink-soft)]">
                    {xpLabel(inst.difficulty, inst.xpOverride)}
                    {inst.categorySlug && catBySlug.get(inst.categorySlug) ? (
                      <> • {catBySlug.get(inst.categorySlug)!.label}</>
                    ) : null}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <TaskDetailsDialog
        instance={selected}
        onClose={() => setSelected(null)}
        catBySlug={catBySlug}
      />

      <ParentCompleteConfirm
        pending={pendingComplete}
        onCancel={() => setPendingComplete(null)}
        onConfirm={() => {
          if (!pendingComplete) return
          complete.mutate({
            instanceId: pendingComplete.instanceId,
            force: true,
          })
          setPendingComplete(null)
        }}
      />
    </main>
  )
}

function StepsBadge({
  completed,
  total,
}: {
  completed: number
  total: number
}) {
  const done = completed >= total
  return (
    <span
      className={`flex-shrink-0 rounded-full border px-1.5 py-0 text-[10px] font-semibold ${
        done
          ? 'border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] text-[var(--lagoon-deep)]'
          : 'border-[var(--line)] bg-[var(--option-bg)] text-[var(--sea-ink-soft)]'
      }`}
      aria-label={`${completed} of ${total} steps done`}
    >
      {completed}/{total}
    </span>
  )
}

function ParentCompleteConfirm({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: { instanceId: string; title: string; unchecked: number } | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (pending && !el.open) el.showModal()
    else if (!pending && el.open) el.close()
  }, [pending])

  return (
    <dialog
      ref={dialogRef}
      onClose={onCancel}
      onClick={(e) => {
        if (e.target === dialogRef.current) onCancel()
      }}
      className="m-auto w-[min(420px,calc(100%-1.5rem))] rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-0 text-[var(--sea-ink)] shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
    >
      {pending ? (
        <div className="flex flex-col gap-4 p-5">
          <div>
            <h3 className="display-title text-lg font-bold text-[var(--sea-ink)]">
              Complete anyway?
            </h3>
            <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
              "{pending.title}" still has {pending.unchecked} unchecked{' '}
              {pending.unchecked === 1 ? 'step' : 'steps'}. Completing the
              task will only grant the parent's completion bonus — the
              remaining step XP will be skipped.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--sea-ink-soft)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-3 py-1.5 text-xs font-semibold text-[var(--lagoon-deep)]"
            >
              Complete
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
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

function CoachBlurb({ instances }: { instances: TodayInstance[] }) {
  // A signature derived from the state the coach cares about. When it
  // changes, the React Query key changes, so Query auto-fetches fresh copy.
  //
  // Included in the sig:
  //  - open instance IDs (sorted) → completes / skips / snoozes / adds all flip this
  //  - xp → any completion bumps this
  //  - current streak → day rollovers flip this
  //  - hour bucket (every 2h) → covers idle users via refetchInterval too
  // Defer rendering until the client has mounted. The coach summary is
  // purely a loaded blurb; SSR would always show the skeleton <div> while
  // the persisted client cache often returns the final <p> on hydration,
  // tripping a React 19 hydration error.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // Signature = just the set of open instance IDs. Every real-world
  // trigger we care about (add / complete / skip / snooze / day rollover
  // pulling in new instances) flips this set. Earlier versions also
  // included xp + currentStreak + hourBucket, but those double-fire
  // against a single completion: `today` and `progression` invalidate
  // separately, so the signature would flip twice and the coach would
  // run twice. The refetchInterval below handles the idle case; no need
  // to rotate the key on a clock.
  const signature = useMemo(
    () => instances.map((i) => i.instanceId).sort().join(','),
    [instances],
  )

  const query = useQuery({
    queryKey: ['coach', signature],
    queryFn: () => getCoachSummary(),
    enabled: mounted,
    // Key already encodes freshness; don't re-run on remount. Let
    // refetchInterval cover the idle-user case.
    staleTime: Infinity,
    gcTime: 1000 * 60 * 60 * 4,
    refetchInterval: 1000 * 60 * 60 * 2,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  })

  if (!mounted) return null
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

function TodayBuckets({
  instances,
  catBySlug,
  onComplete,
  onSnooze,
  onSkip,
  onSelect,
}: {
  instances: TodayInstance[]
  catBySlug: Map<string, { label: string; color: string }>
  onComplete: (inst: TodayInstance) => void
  onSnooze: (instanceId: string) => void
  onSkip: (instanceId: string) => void
  onSelect: (inst: TaskDetailsInstance) => void
}) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const current = currentDayPart(new Date(), timeZone)

  // Group by day-part but keep the existing sort order within each group.
  const byPart = new Map<DayPart, TodayInstance[]>()
  for (const inst of instances) {
    const part = partForTimeOfDay(inst.timeOfDay)
    const arr = byPart.get(part) ?? []
    arr.push(inst)
    byPart.set(part, arr)
  }

  const anytime = byPart.get('anytime') ?? []
  const timedNow: Array<{ part: DayPart; rows: TodayInstance[] }> = []
  const timedLater: Array<{ part: DayPart; rows: TodayInstance[] }> = []
  for (const part of TIMED_DAY_PARTS) {
    const rows = byPart.get(part)
    if (!rows || rows.length === 0) continue
    if (isBucketCurrentOrPast(part, current)) {
      timedNow.push({ part, rows })
    } else {
      timedLater.push({ part, rows })
    }
  }

  const laterCount = timedLater.reduce((acc, g) => acc + g.rows.length, 0)

  return (
    <div className="space-y-6">
      {anytime.length > 0 ? (
        <BucketList
          rows={anytime}
          catBySlug={catBySlug}
          onComplete={onComplete}
          onSnooze={onSnooze}
          onSkip={onSkip}
          onSelect={onSelect}
        />
      ) : null}

      {timedNow.map((g) => (
        <section key={g.part}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            {DAY_PART_LABEL[g.part]}
          </h2>
          <BucketList
            rows={g.rows}
            catBySlug={catBySlug}
            onComplete={onComplete}
            onSnooze={onSnooze}
            onSkip={onSkip}
            onSelect={onSelect}
          />
        </section>
      ))}

      {timedLater.length > 0 ? (
        <details className="rounded-xl border border-[var(--line)] bg-[var(--option-bg)] p-3">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
            Later today ({laterCount})
          </summary>
          <div className="mt-3 space-y-4">
            {timedLater.map((g) => (
              <section key={g.part}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--kicker)]">
                  {DAY_PART_LABEL[g.part]}
                </h2>
                <BucketList
                  rows={g.rows}
                  catBySlug={catBySlug}
                  onComplete={onComplete}
                  onSnooze={onSnooze}
                  onSkip={onSkip}
                  onSelect={onSelect}
                />
              </section>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  )
}

function BucketList({
  rows,
  catBySlug,
  onComplete,
  onSnooze,
  onSkip,
  onSelect,
}: {
  rows: TodayInstance[]
  catBySlug: Map<string, { label: string; color: string }>
  onComplete: (inst: TodayInstance) => void
  onSnooze: (instanceId: string) => void
  onSkip: (instanceId: string) => void
  onSelect: (inst: TaskDetailsInstance) => void
}) {
  return (
    <ul className="space-y-2">
      {rows.map((inst) => (
        <li
          key={inst.instanceId}
          className="island-shell flex items-center gap-3 rounded-xl p-3"
        >
          <button
            type="button"
            aria-label={`Complete ${inst.title}`}
            onClick={() => onComplete(inst)}
            className="h-6 w-6 flex-shrink-0 rounded-full border-2 border-[rgba(50,143,151,0.4)] transition hover:border-[var(--lagoon-deep)] hover:bg-[rgba(79,184,178,0.16)]"
          />
          <button
            type="button"
            onClick={() =>
              onSelect({
                taskId: inst.taskId,
                instanceId: inst.instanceId,
                title: inst.title,
                difficulty: inst.difficulty,
                xpOverride: inst.xpOverride,
                categorySlug: inst.categorySlug,
                dueAt: inst.dueAt,
                timeOfDay: inst.timeOfDay,
              })
            }
            className="min-w-0 flex-1 cursor-pointer bg-transparent p-0 text-left"
            aria-label={`View ${inst.title}`}
          >
            <p className="flex items-center gap-1.5 font-semibold text-[var(--sea-ink)]">
              <CategoryDot slug={inst.categorySlug} map={catBySlug} />
              <span className="truncate">{inst.title}</span>
              {inst.stepsTotal > 0 ? (
                <StepsBadge
                  completed={inst.stepsCompleted}
                  total={inst.stepsTotal}
                />
              ) : null}
            </p>
            <p className="text-xs text-[var(--sea-ink-soft)]">
              {dueLabel(inst.dueAt, inst.timeOfDay, inst.dueKind)}
              {' • '}
              {xpLabel(inst.difficulty, inst.xpOverride)}
              {inst.categorySlug && catBySlug.get(inst.categorySlug) ? (
                <> • {catBySlug.get(inst.categorySlug)!.label}</>
              ) : null}
            </p>
          </button>
          <div className="flex flex-shrink-0 flex-col items-stretch gap-1 sm:flex-row sm:items-center">
            <Link
              to="/focus"
              search={{
                taskInstanceId: inst.instanceId,
                taskTitle: inst.title,
              }}
              aria-label={`Focus on ${inst.title}`}
              className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-2.5 py-1 text-center text-xs font-semibold text-[var(--sea-ink-soft)] no-underline transition hover:text-[var(--sea-ink)]"
            >
              🎯 Focus
            </Link>
            <IconButton
              label={`Snooze ${inst.title} for 1 hour`}
              onClick={() => onSnooze(inst.instanceId)}
            >
              ⏰ 1h
            </IconButton>
            <IconButton
              label={`Skip ${inst.title}`}
              onClick={() => onSkip(inst.instanceId)}
            >
              ⏭ Skip
            </IconButton>
          </div>
        </li>
      ))}
    </ul>
  )
}

function CategoryDot({
  slug,
  map,
}: {
  slug: string | null
  map: Map<string, { label: string; color: string }>
}) {
  const cat = slug ? map.get(slug) : null
  return (
    <span
      aria-hidden
      title={cat?.label ?? 'Uncategorized'}
      className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
      style={{
        backgroundColor: cat?.color ?? 'transparent',
        border: cat ? 'none' : '1px dashed var(--line)',
      }}
    />
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
      className="rounded-full border border-[var(--line)] bg-[var(--option-bg)] px-2.5 py-1 text-center text-xs font-semibold text-[var(--sea-ink-soft)] transition hover:text-[var(--sea-ink)]"
    >
      {children}
    </button>
  )
}

function dueLabel(
  dueAt: string,
  timeOfDay: string | null,
  dueKind: 'hard' | 'week_target' = 'hard',
): string {
  const d = new Date(dueAt)
  const now = new Date()
  const dayMs = 86_400_000
  // Week-target tasks live in the list all week, so the label needs to
  // tell the user where in the curve they are: target day name + a tiny
  // "bonus if early" cue.
  if (dueKind === 'week_target') {
    const sameDay = d.toDateString() === now.toDateString()
    if (sameDay) return 'Target today • full XP'
    const diffMs = d.getTime() - now.getTime()
    if (diffMs > 0) {
      const days = Math.ceil(diffMs / dayMs)
      const weekday = d.toLocaleDateString(undefined, { weekday: 'short' })
      return `Target ${weekday} • bonus if early (${days}d)`
    }
    // Past the target day — falls into the soft late curve.
    const daysLate = Math.floor(-diffMs / dayMs)
    return daysLate <= 2
      ? `Past target by ${daysLate}d • partial XP`
      : `Past target by ${daysLate}d • late floor`
  }
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
