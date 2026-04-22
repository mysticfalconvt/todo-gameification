import { useState } from 'react'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FocusTimer } from '../../components/focus/FocusTimer'
import {
  completeFocusSession,
  startFocusSession,
} from '../../server/functions/focus'
import { completeInstance } from '../../server/functions/tasks'

type Duration = 15 | 25 | 50
const DURATIONS: readonly Duration[] = [15, 25, 50] as const

type Phase = 'picking' | 'running' | 'confirming'

interface FocusSearch {
  taskInstanceId?: string
  taskTitle?: string
}

export const Route = createFileRoute('/_authenticated/focus')({
  component: FocusPage,
  validateSearch: (s: Record<string, unknown>): FocusSearch => ({
    taskInstanceId:
      typeof s.taskInstanceId === 'string' ? s.taskInstanceId : undefined,
    taskTitle:
      typeof s.taskTitle === 'string' ? s.taskTitle : undefined,
  }),
})

function FocusPage() {
  const search = useSearch({ from: '/_authenticated/focus' })
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [duration, setDuration] = useState<Duration>(25)
  const [phase, setPhase] = useState<Phase>('picking')

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['progression'] })
    qc.invalidateQueries({ queryKey: ['today'] })
    qc.invalidateQueries({ queryKey: ['recent-activity'] })
  }

  const completeFocus = useMutation({
    mutationFn: (input: { durationMin: Duration; taskInstanceId?: string }) =>
      completeFocusSession({ data: input }),
    onSuccess: (result) => {
      invalidateAll()
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

  const onTimerComplete = () => {
    setPhase('confirming')
  }

  const onCancel = () => {
    setPhase('picking')
    navigate({ to: '/today' })
  }

  // Task-linked confirmation handler: always award focus; task completion is
  // conditional on the user's self-report.
  const handleTaskConfirm = async (didCompleteTask: boolean) => {
    await completeFocus.mutateAsync({
      durationMin: duration,
      taskInstanceId: search.taskInstanceId,
    })
    if (didCompleteTask && search.taskInstanceId) {
      await completeTask.mutateAsync(search.taskInstanceId)
      toast.success('Task marked done.')
    }
    navigate({ to: '/today' })
  }

  // Standalone confirmation: "no" forfeits rewards — no focus.completed event
  // is written, so it shows as started-but-not-completed in stats.
  const handleStandaloneConfirm = async (wasSuccessful: boolean) => {
    if (wasSuccessful) {
      await completeFocus.mutateAsync({ durationMin: duration })
    } else {
      toast('Session not counted. Honesty appreciated.')
    }
    navigate({ to: '/today' })
  }

  if (phase === 'confirming') {
    return (
      <main className="page-wrap px-4 py-8">
        <ConfirmationPrompt
          taskLinked={Boolean(search.taskInstanceId)}
          taskTitle={search.taskTitle}
          pending={completeFocus.isPending || completeTask.isPending}
          onTaskConfirm={handleTaskConfirm}
          onStandaloneConfirm={handleStandaloneConfirm}
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
          Earn tokens for uninterrupted time with the app. Lock or switch apps
          and the timer pauses — no cheating the clock.
        </p>
      </header>

      <section className="island-shell mb-4 rounded-2xl p-4">
        <div role="radiogroup" aria-label="Session duration" className="grid grid-cols-3 gap-2">
          {DURATIONS.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={duration === d}
              onClick={() => setDuration(d)}
              className={[
                'rounded-xl border px-3 py-3 text-sm font-semibold transition',
                duration === d
                  ? 'border-[var(--lagoon-deep)] bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                  : 'border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] text-[var(--sea-ink)] hover:border-[var(--lagoon-deep)]',
              ].join(' ')}
            >
              <div className="text-lg">{d}m</div>
              <div className="text-xs opacity-80">
                +{d === 15 ? 1 : d === 25 ? 2 : 4} 🪙 · +{d === 15 ? 5 : d === 25 ? 10 : 20} XP
              </div>
            </button>
          ))}
        </div>
      </section>

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
        onClick={() => {
          startFocusSession({
            data: {
              durationMin: duration,
              taskInstanceId: search.taskInstanceId ?? null,
            },
          }).catch((err) => {
            // Non-blocking: the session still runs if this fails.
            console.warn('[focus] failed to record start', err)
          })
          setPhase('running')
        }}
        className="w-full rounded-xl bg-[var(--btn-primary-bg)] py-3 font-semibold text-[var(--btn-primary-fg)]"
      >
        Start {duration}-min session
      </button>
    </main>
  )
}

function ConfirmationPrompt({
  taskLinked,
  taskTitle,
  pending,
  onTaskConfirm,
  onStandaloneConfirm,
}: {
  taskLinked: boolean
  taskTitle?: string
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
