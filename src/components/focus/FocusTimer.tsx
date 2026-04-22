import { useCallback, useRef } from 'react'
import { useFocusSession } from '../../lib/useFocusSession'

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

export function FocusTimer({
  durationMin,
  onComplete,
  onCancel,
}: {
  durationMin: 15 | 25 | 50
  onComplete: () => void
  onCancel: () => void
}) {
  const completedRef = useRef(false)
  const handleComplete = useCallback(() => {
    if (completedRef.current) return
    completedRef.current = true
    onComplete()
  }, [onComplete])

  const session = useFocusSession(durationMin, handleComplete)
  const { status, remainingMs, accumulatedMs, plannedMs, wasInterrupted } =
    session

  const started = status !== 'idle'
  const progress = Math.min(1, accumulatedMs / plannedMs)

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 p-6">
      <div className="text-sm text-[var(--sea-ink-soft)]">
        {durationMin}-min focus session
      </div>

      <div
        className="text-7xl font-semibold tabular-nums text-[var(--sea-ink)]"
        aria-live="polite"
      >
        {formatRemaining(remainingMs)}
      </div>

      <div className="h-2 w-full max-w-sm overflow-hidden rounded bg-[var(--btn-subtle-bg)]">
        <div
          className="h-full bg-[var(--lagoon-deep)] transition-[width]"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      {status === 'paused' ? (
        <p className="text-sm text-[var(--sea-ink-soft)]">
          Paused — timer resumes when you return.
        </p>
      ) : status === 'running' && wasInterrupted ? (
        <p className="text-xs text-[var(--sea-ink-soft)]">
          Resumed. Only time with the app open counts.
        </p>
      ) : !started ? (
        <p className="text-sm text-[var(--sea-ink-soft)]">
          Keep the app open. Lock screen or switching apps will pause the timer.
        </p>
      ) : null}

      <div className="flex gap-2">
        {!started ? (
          <button
            type="button"
            onClick={session.start}
            className="rounded bg-[var(--btn-primary-bg)] px-4 py-2 font-semibold text-[var(--btn-primary-fg)]"
          >
            Start
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              session.cancel()
              onCancel()
            }}
            className="rounded border border-[var(--btn-subtle-border)] px-4 py-2 text-sm hover:bg-[var(--btn-subtle-bg)]"
          >
            Cancel session
          </button>
        )}
      </div>
    </div>
  )
}
