import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusSession } from '../../lib/useFocusSession'

// If the user lands here but doesn't click Start within this many seconds,
// fire it automatically. Covers the "I walked off and forgot to hit Start"
// case. They can cancel the auto-start with the inline link.
const AUTO_START_SECONDS = 10

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

export function FocusTimer({
  durationMin,
  taskTitle,
  plannedMsOverride,
  onComplete,
  onCancel,
}: {
  durationMin: 15 | 25 | 50
  taskTitle?: string
  // Test-mode override (e.g., 10s instead of 15 min). Keeps the server
  // reward mapping unchanged since durationMin is still the logical value.
  plannedMsOverride?: number
  onComplete: () => void
  onCancel: () => void
}) {
  const completedRef = useRef(false)
  const handleComplete = useCallback(() => {
    if (completedRef.current) return
    completedRef.current = true
    onComplete()
  }, [onComplete])

  const plannedMs = plannedMsOverride ?? durationMin * 60_000
  const session = useFocusSession(plannedMs, handleComplete)
  const { status, remainingMs, accumulatedMs, wasInterrupted } = session

  const started = status !== 'idle'
  const progress = Math.min(1, accumulatedMs / plannedMs)

  const [autoStartIn, setAutoStartIn] = useState<number | null>(
    AUTO_START_SECONDS,
  )
  const cancelAutoStart = useCallback(() => setAutoStartIn(null), [])

  useEffect(() => {
    if (started || autoStartIn === null) return
    if (autoStartIn <= 0) {
      setAutoStartIn(null)
      session.start()
      return
    }
    const id = window.setTimeout(() => setAutoStartIn(autoStartIn - 1), 1000)
    return () => window.clearTimeout(id)
  }, [autoStartIn, started, session])

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 p-6">
      <div className="flex flex-col items-center gap-1 text-center">
        <div className="text-sm text-[var(--sea-ink-soft)]">
          {durationMin}-min focus session
        </div>
        {taskTitle ? (
          <div className="max-w-xs text-lg font-semibold text-[var(--sea-ink)]">
            {taskTitle}
          </div>
        ) : null}
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
            onClick={() => {
              cancelAutoStart()
              session.start()
            }}
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

      {!started && autoStartIn !== null ? (
        <p
          className="text-center text-xs text-[var(--sea-ink-soft)]"
          aria-live="polite"
        >
          Auto-starting in {autoStartIn}s.{' '}
          <button
            type="button"
            onClick={cancelAutoStart}
            className="underline"
          >
            Cancel
          </button>
        </p>
      ) : null}
    </div>
  )
}
