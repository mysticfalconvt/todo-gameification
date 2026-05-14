import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FocusTimer } from '../../components/focus/FocusTimer'
import {
  cancelFocusSession,
  completeFocusSession,
  getActiveFocusSession,
  startFocusSession,
} from '../../server/functions/focus'
import { completeInstance } from '../../server/functions/tasks'
import {
  focusRewardsFor,
  type FocusMode,
} from '../../domain/events'
import { isIosNonStandalone } from '../../lib/platform'
import { currentPushStatus } from '../../lib/push'

type Duration = 5 | 10 | 15 | 25 | 50
const DURATIONS: readonly Duration[] = [5, 10, 15, 25, 50] as const

type Phase = 'picking' | 'running' | 'pocket' | 'confirming'

interface FocusSearch {
  taskInstanceId?: string
  taskTitle?: string
  // Deep link from the end-of-session push: jumps straight to the
  // confirmation modal for the named active session.
  focus_confirm?: string
}

export const Route = createFileRoute('/_authenticated/focus')({
  component: FocusPage,
  validateSearch: (s: Record<string, unknown>): FocusSearch => ({
    taskInstanceId:
      typeof s.taskInstanceId === 'string' ? s.taskInstanceId : undefined,
    taskTitle:
      typeof s.taskTitle === 'string' ? s.taskTitle : undefined,
    focus_confirm:
      typeof s.focus_confirm === 'string' ? s.focus_confirm : undefined,
  }),
})

function FocusPage() {
  const search = useSearch({ from: '/_authenticated/focus' })
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [duration, setDuration] = useState<Duration>(25)
  const [mode, setMode] = useState<FocusMode>('visible')
  const [phase, setPhase] = useState<Phase>('picking')
  // Tracks the in-flight session (set on start, cleared on
  // confirm/cancel). Used to identify the row for cancel + complete.
  const [activeStart, setActiveStart] = useState<{
    startEventId: string
    expectedEndAt: Date
    mode: FocusMode
    durationMin: Duration
    taskInstanceId: string | null
  } | null>(null)

  // On mount, check for an existing server-tracked session. We only
  // *adopt* it once — subsequent query refetches (e.g., after starting
  // a new session locally) must not re-run the restore logic, or they
  // would yank the user out of the running phase.
  const active = useQuery({
    queryKey: ['active-focus-session'],
    queryFn: () => getActiveFocusSession(),
    staleTime: 0,
    refetchOnWindowFocus: true,
  })

  const didRestoreRef = useRef(false)
  useEffect(() => {
    if (didRestoreRef.current) return
    if (active.isLoading) return
    didRestoreRef.current = true
    const session = active.data
    if (!session) return
    const expectedEndAt = new Date(session.expectedEndAt)
    // Pocket = server-tracked, safe to resume any time. Visible only
    // restores if the user came in via a focus_confirm deep link
    // (e.g., a stray notification from a prior pocket session) — a
    // bare visible session in the log doesn't carry enough state to
    // resurrect mid-flight, so we ignore it and let the user start
    // fresh.
    if (search.focus_confirm && search.focus_confirm === session.startEventId) {
      setActiveStart({
        startEventId: session.startEventId,
        expectedEndAt,
        mode: session.mode,
        durationMin: session.durationMin as Duration,
        taskInstanceId: session.taskInstanceId,
      })
      setDuration(session.durationMin as Duration)
      setMode(session.mode)
      setPhase('confirming')
      return
    }
    if (session.mode === 'pocket') {
      setActiveStart({
        startEventId: session.startEventId,
        expectedEndAt,
        mode: session.mode,
        durationMin: session.durationMin as Duration,
        taskInstanceId: session.taskInstanceId,
      })
      setDuration(session.durationMin as Duration)
      setMode(session.mode)
      setPhase('pocket')
    }
  }, [active.data, active.isLoading, search.focus_confirm])

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['progression'] })
    qc.invalidateQueries({ queryKey: ['today'] })
    qc.invalidateQueries({ queryKey: ['recent-activity'] })
    qc.invalidateQueries({ queryKey: ['active-focus-session'] })
  }

  const completeFocus = useMutation({
    mutationFn: (input: {
      durationMin: Duration
      mode: FocusMode
      startEventId?: string | null
      taskInstanceId?: string | null
    }) => completeFocusSession({ data: input }),
    onSuccess: (result) => {
      invalidateAll()
      if (result.duplicate) {
        toast('Already counted on another device.')
        return
      }
      toast.success(
        `Focus logged! +${result.xpEarned} XP, +${result.tokensEarned} 🪙`,
      )
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Focus log failed')
    },
  })

  const completeTask = useMutation({
    mutationFn: (instanceId: string) =>
      completeInstance({ data: { instanceId } }),
    onSuccess: () => {
      invalidateAll()
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Task complete failed')
    },
  })

  const cancelSession = useMutation({
    mutationFn: (startEventId: string) =>
      cancelFocusSession({ data: { startEventId } }),
    onSuccess: () => invalidateAll(),
  })

  const onTimerComplete = () => {
    setPhase('confirming')
  }

  const onCancel = () => {
    if (activeStart) {
      cancelSession.mutate(activeStart.startEventId)
    }
    setActiveStart(null)
    setPhase('picking')
    navigate({ to: '/today' })
  }

  const handleTaskConfirm = async (didCompleteTask: boolean) => {
    await completeFocus.mutateAsync({
      durationMin: activeStart?.durationMin ?? duration,
      mode: activeStart?.mode ?? mode,
      startEventId: activeStart?.startEventId ?? null,
      taskInstanceId: activeStart?.taskInstanceId ?? search.taskInstanceId,
    })
    const instanceId = activeStart?.taskInstanceId ?? search.taskInstanceId
    if (didCompleteTask && instanceId) {
      await completeTask.mutateAsync(instanceId)
      toast.success('Task marked done.')
    }
    setActiveStart(null)
    navigate({ to: '/today' })
  }

  const handleStandaloneConfirm = async (wasSuccessful: boolean) => {
    if (wasSuccessful) {
      await completeFocus.mutateAsync({
        durationMin: activeStart?.durationMin ?? duration,
        mode: activeStart?.mode ?? mode,
        startEventId: activeStart?.startEventId ?? null,
      })
    } else {
      if (activeStart) {
        cancelSession.mutate(activeStart.startEventId)
      }
      toast('Session not counted. Honesty appreciated.')
    }
    setActiveStart(null)
    navigate({ to: '/today' })
  }

  const startSession = useCallback(async () => {
    try {
      const result = await startFocusSession({
        data: {
          durationMin: duration,
          mode,
          taskInstanceId: search.taskInstanceId ?? null,
        },
      })
      setActiveStart({
        startEventId: result.startEventId,
        expectedEndAt: new Date(result.expectedEndAt),
        mode,
        durationMin: duration,
        taskInstanceId: search.taskInstanceId ?? null,
      })
      setPhase(mode === 'pocket' ? 'pocket' : 'running')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start')
    }
  }, [duration, mode, qc, search.taskInstanceId])

  if (phase === 'confirming') {
    return (
      <main className="page-wrap px-4 py-8">
        <ConfirmationPrompt
          taskLinked={Boolean(
            activeStart?.taskInstanceId ?? search.taskInstanceId,
          )}
          taskTitle={search.taskTitle}
          durationMin={activeStart?.durationMin ?? duration}
          pending={completeFocus.isPending || completeTask.isPending}
          onTaskConfirm={handleTaskConfirm}
          onStandaloneConfirm={handleStandaloneConfirm}
        />
      </main>
    )
  }

  if (phase === 'pocket' && activeStart) {
    return (
      <main className="page-wrap px-4 py-8">
        <PocketWaiting
          expectedEndAt={activeStart.expectedEndAt}
          durationMin={activeStart.durationMin}
          taskTitle={search.taskTitle}
          onCancel={onCancel}
          onConfirmNow={() => setPhase('confirming')}
        />
      </main>
    )
  }

  if (phase === 'running') {
    return (
      <main className="page-wrap px-4 py-8">
        <FocusTimer
          durationMin={duration}
          taskTitle={search.taskTitle}
          onComplete={onTimerComplete}
          onCancel={onCancel}
        />
      </main>
    )
  }

  return (
    <main className="page-wrap px-4 py-8">
      <header className="mb-6">
        <p className="island-kicker mb-1">Focus</p>
        <h1 className="display-title text-4xl font-bold text-[var(--sea-ink)]">
          Pick a duration
        </h1>
        <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
          Earn tokens for uninterrupted focus time.
        </p>
      </header>

      <ModePicker mode={mode} onChange={setMode} />

      <section className="island-shell mb-4 rounded-2xl p-4">
        <div role="radiogroup" aria-label="Session duration" className="grid grid-cols-5 gap-1.5 sm:gap-2">
          {DURATIONS.map((d) => {
            const reward = focusRewardsFor(mode)[d]
            return (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={duration === d}
                onClick={() => setDuration(d)}
                className={[
                  'rounded-xl border px-1 py-2.5 text-sm font-semibold transition sm:px-3 sm:py-3',
                  duration === d
                    ? 'border-[var(--lagoon-deep)] bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                    : 'border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] text-[var(--sea-ink)] hover:border-[var(--lagoon-deep)]',
                ].join(' ')}
              >
                <div className="text-base sm:text-lg">{d}m</div>
                <div className="text-[10px] opacity-80 sm:text-xs">
                  +{reward.tokens}🪙 +{reward.xp}xp
                </div>
              </button>
            )
          })}
        </div>
      </section>

      {mode === 'pocket' ? <PocketReadinessHints /> : null}

      {search.taskInstanceId ? (
        <p className="mb-4 text-xs text-[var(--sea-ink-soft)]">
          {search.taskTitle ? (
            <>Focusing on <span className="font-semibold">{search.taskTitle}</span>. We'll ask if you finished it when the timer ends.</>
          ) : (
            <>We'll ask if you finished the task when the timer ends.</>
          )}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void startSession()}
        className="w-full rounded-xl bg-[var(--btn-primary-bg)] py-3 font-semibold text-[var(--btn-primary-fg)]"
      >
        Start {duration}-min {mode === 'pocket' ? 'pocket' : 'session'}
      </button>
    </main>
  )
}

function ModePicker({
  mode,
  onChange,
}: {
  mode: FocusMode
  onChange: (m: FocusMode) => void
}) {
  return (
    <section className="island-shell mb-4 rounded-2xl p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
        Mode
      </div>
      <div role="radiogroup" aria-label="Focus mode" className="grid grid-cols-2 gap-2">
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'visible'}
          onClick={() => onChange('visible')}
          className={[
            'rounded-xl border px-3 py-3 text-left transition',
            mode === 'visible'
              ? 'border-[var(--lagoon-deep)] bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
              : 'border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] text-[var(--sea-ink)] hover:border-[var(--lagoon-deep)]',
          ].join(' ')}
        >
          <div className="text-sm font-semibold">👀 Visible</div>
          <div className="mt-1 text-[11px] opacity-80">
            Keep the app open. Backgrounding pauses. +1 token bonus on longer tiers.
          </div>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'pocket'}
          onClick={() => onChange('pocket')}
          className={[
            'rounded-xl border px-3 py-3 text-left transition',
            mode === 'pocket'
              ? 'border-[var(--lagoon-deep)] bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
              : 'border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] text-[var(--sea-ink)] hover:border-[var(--lagoon-deep)]',
          ].join(' ')}
        >
          <div className="text-sm font-semibold">📱 Pocket</div>
          <div className="mt-1 text-[11px] opacity-80">
            Phone away. We'll push you when time's up. Needs notifications on.
          </div>
        </button>
      </div>
    </section>
  )
}

// Surfaces preflight gotchas for Pocket mode: notifications must be on,
// and on iOS the app needs to be installed to home screen for push.
function PocketReadinessHints() {
  const [pushStatus, setPushStatus] = useState<
    'unsupported' | 'unknown' | 'enabled' | 'disabled' | null
  >(null)
  const iosNonStandalone = useMemo(() => isIosNonStandalone(), [])

  useEffect(() => {
    let cancelled = false
    currentPushStatus().then((s) => {
      if (!cancelled) setPushStatus(s)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (iosNonStandalone) {
    return (
      <div className="mb-4 rounded-xl border border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] p-3 text-xs text-[var(--sea-ink)]">
        <div className="font-semibold">📲 Install to home screen for Pocket mode</div>
        <div className="mt-1 opacity-80">
          iOS Safari only delivers push notifications when this app is
          installed. Tap <span className="font-mono">Share → Add to Home Screen</span>,
          then come back.
        </div>
      </div>
    )
  }
  if (pushStatus === 'disabled' || pushStatus === 'unknown') {
    return (
      <div className="mb-4 rounded-xl border border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] p-3 text-xs text-[var(--sea-ink)]">
        <div className="font-semibold">🔔 Enable notifications first</div>
        <div className="mt-1 opacity-80">
          Pocket sessions notify you when the timer ends. Turn on push in
          Settings before starting — without it, you'll have to reopen the
          app to confirm.
        </div>
      </div>
    )
  }
  if (pushStatus === 'unsupported') {
    return (
      <div className="mb-4 rounded-xl border border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] p-3 text-xs text-[var(--sea-ink)]">
        <div className="font-semibold">⚠️ Push not supported here</div>
        <div className="mt-1 opacity-80">
          This browser can't receive push notifications. The session will
          still track on the server — you'll just have to come back to the
          app to confirm.
        </div>
      </div>
    )
  }
  return null
}

function PocketWaiting({
  expectedEndAt,
  durationMin,
  taskTitle,
  onCancel,
  onConfirmNow,
}: {
  expectedEndAt: Date
  durationMin: 5 | 10 | 15 | 25 | 50
  taskTitle?: string
  onCancel: () => void
  onConfirmNow: () => void
}) {
  // Coarse countdown — server is the source of truth, this is just a
  // visual hint. Updates once per second.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const remainingMs = Math.max(0, expectedEndAt.getTime() - now)
  const done = remainingMs <= 0
  const endTimeLabel = expectedEndAt.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 p-6 text-center">
      <div className="text-5xl">📱</div>
      <h2 className="display-title text-3xl font-bold text-[var(--sea-ink)]">
        Pocket session running
      </h2>
      <p className="text-sm text-[var(--sea-ink-soft)]">
        {durationMin}-min focus. Phone can be locked or away — we'll push
        you at <span className="font-semibold">{endTimeLabel}</span>.
      </p>
      {taskTitle ? (
        <p className="text-base font-semibold text-[var(--sea-ink)]">
          {taskTitle}
        </p>
      ) : null}

      <div className="text-6xl font-semibold tabular-nums text-[var(--sea-ink)]" aria-live="polite">
        {formatPocketRemaining(remainingMs)}
      </div>

      {done ? (
        <button
          type="button"
          onClick={onConfirmNow}
          className="rounded-xl bg-[var(--btn-primary-bg)] px-6 py-3 font-semibold text-[var(--btn-primary-fg)]"
        >
          ✓ Claim my reward
        </button>
      ) : (
        <p className="text-xs text-[var(--sea-ink-soft)]">
          You can close this tab. The session keeps running on our server.
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-[var(--btn-subtle-border)] px-4 py-2 text-sm hover:bg-[var(--btn-subtle-bg)]"
        >
          Cancel session
        </button>
      </div>
    </div>
  )
}

function formatPocketRemaining(ms: number): string {
  if (ms <= 0) return 'Time’s up'
  const total = Math.ceil(ms / 1000)
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

function ConfirmationPrompt({
  taskLinked,
  taskTitle,
  durationMin,
  pending,
  onTaskConfirm,
  onStandaloneConfirm,
}: {
  taskLinked: boolean
  taskTitle?: string
  durationMin: 5 | 10 | 15 | 25 | 50
  pending: boolean
  onTaskConfirm: (didCompleteTask: boolean) => void
  onStandaloneConfirm: (wasSuccessful: boolean) => void
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 p-6 text-center">
      <div className="text-5xl">⏰</div>
      <h2 className="display-title text-3xl font-bold text-[var(--sea-ink)]">
        Time's up!
      </h2>
      <p className="text-xs text-[var(--sea-ink-soft)]">
        {durationMin}-min session
      </p>
      {taskLinked ? (
        <>
          {taskTitle ? (
            <p className="text-base font-semibold text-[var(--sea-ink)]">
              “{taskTitle}”
            </p>
          ) : null}
          <p className="text-sm text-[var(--sea-ink-soft)]">
            {taskTitle
              ? `Did you finish it? Focus rewards are awarded either way.`
              : `Did you finish the task? Focus rewards are awarded either way.`}
          </p>
          <div className="flex w-full max-w-sm flex-col gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => onTaskConfirm(true)}
              className="rounded-xl bg-[var(--btn-primary-bg)] py-3 font-semibold text-[var(--btn-primary-fg)] disabled:opacity-50"
            >
              ✓ Yes, mark it done
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => onTaskConfirm(false)}
              className="rounded-xl border border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] py-3 font-semibold text-[var(--sea-ink)] disabled:opacity-50"
            >
              Not yet — just log the focus
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-[var(--sea-ink-soft)]">
            Was this a successful focus session? Answering no forfeits the
            rewards (honesty clause).
          </p>
          <div className="flex w-full max-w-sm flex-col gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => onStandaloneConfirm(true)}
              className="rounded-xl bg-[var(--btn-primary-bg)] py-3 font-semibold text-[var(--btn-primary-fg)] disabled:opacity-50"
            >
              ✓ Yes, I focused
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => onStandaloneConfirm(false)}
              className="rounded-xl border border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] py-3 font-semibold text-[var(--sea-ink)] disabled:opacity-50"
            >
              No — don't count it
            </button>
          </div>
        </>
      )}
    </div>
  )
}
