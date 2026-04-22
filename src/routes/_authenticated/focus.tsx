import { useState } from 'react'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FocusTimer } from '../../components/focus/FocusTimer'
import {
  completeFocusSession,
  startFocusSession,
} from '../../server/functions/focus'

type Duration = 15 | 25 | 50
const DURATIONS: readonly Duration[] = [15, 25, 50] as const

interface FocusSearch {
  taskInstanceId?: string
}

export const Route = createFileRoute('/_authenticated/focus')({
  component: FocusPage,
  validateSearch: (s: Record<string, unknown>): FocusSearch => ({
    taskInstanceId:
      typeof s.taskInstanceId === 'string' ? s.taskInstanceId : undefined,
  }),
})

function FocusPage() {
  const search = useSearch({ from: '/_authenticated/focus' })
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [duration, setDuration] = useState<Duration>(25)
  const [running, setRunning] = useState(false)

  const complete = useMutation({
    mutationFn: (input: { durationMin: Duration; taskInstanceId?: string }) =>
      completeFocusSession({ data: input }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['progression'] })
      qc.invalidateQueries({ queryKey: ['today'] })
      qc.invalidateQueries({ queryKey: ['recent-activity'] })
      const coinPart = `+${result.tokensEarned} 🪙`
      const xpPart = `+${result.xpEarned} XP`
      const extra = result.taskCompleted ? ' · task done' : ''
      toast.success(`Focus done! ${xpPart}, ${coinPart}${extra}`)
      navigate({ to: '/today' })
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Focus session failed')
      navigate({ to: '/today' })
    },
  })

  const onTimerComplete = () => {
    complete.mutate({ durationMin: duration, taskInstanceId: search.taskInstanceId })
  }

  const onCancel = () => {
    setRunning(false)
    navigate({ to: '/today' })
  }

  if (running) {
    return (
      <main className="page-wrap px-4 py-8">
        <FocusTimer
          durationMin={duration}
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
          Session will mark the linked task done on completion.
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
          setRunning(true)
        }}
        className="w-full rounded-xl bg-[var(--btn-primary-bg)] py-3 font-semibold text-[var(--btn-primary-fg)]"
      >
        Start {duration}-min session
      </button>
    </main>
  )
}
