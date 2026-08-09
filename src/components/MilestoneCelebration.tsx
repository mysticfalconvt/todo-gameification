import { useEffect, useRef, useState } from 'react'

// A one-off, full-screen celebration overlay. Fires a confetti burst and a
// centered card for a streak milestone or a level-up, then auto-dismisses.
//
// The celebration is ephemeral and driven entirely by the `event` prop: pass
// a fresh object (with a unique `key`) to trigger it, or null for nothing.
// Rendering is dependency-free — confetti is CSS (see styles.css
// `.confetti-piece`), so nothing is pulled in at runtime.

export interface CelebrationEvent {
  // Monotonic key so re-firing the same kind of celebration re-triggers the
  // animation (React remounts on key change).
  key: number
  kind: 'milestone' | 'level'
  title: string
  subtitle: string
  glyph: string
}

const CONFETTI_COLORS = ['#4fb8b2', '#f4b942', '#ef6f6c', '#8ac6d1', '#f7f4d3', '#328f97']
const PIECE_COUNT = 36
const DISMISS_MS = 2600

// Deterministic pseudo-random in [0,1) from an integer seed — avoids
// Math.random so the burst is stable across a re-render within one mount.
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

export function MilestoneCelebration({
  event,
  onDone,
}: {
  event: CelebrationEvent | null
  onDone: () => void
}) {
  const [visible, setVisible] = useState(false)

  // Callers pass an inline `onDone={() => ...}`, so it's a new function every
  // render. Depending on it directly would clear and restart the dismiss timer
  // on every parent render — the overlay would never time out while anything
  // above it was re-rendering. Hold the latest one in a ref instead.
  const onDoneRef = useRef(onDone)
  useEffect(() => {
    onDoneRef.current = onDone
  })

  // Re-runs whenever a new celebration is handed in: callers set a fresh event
  // object per fire, so its identity is stable between fires.
  useEffect(() => {
    if (!event) return
    setVisible(true)
    const t = setTimeout(() => {
      setVisible(false)
      onDoneRef.current()
    }, DISMISS_MS)
    return () => clearTimeout(t)
  }, [event])

  if (!event || !visible) return null

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center overflow-hidden"
      role="status"
      aria-live="polite"
    >
      {/* Confetti layer */}
      <div className="absolute inset-0">
        {Array.from({ length: PIECE_COUNT }).map((_, i) => {
          const left = rand(i + 1) * 100
          const drift = (rand(i + 2) - 0.5) * 200
          const delay = rand(i + 3) * 500
          const spin = 360 + rand(i + 4) * 540
          const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length]
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length decorative burst; pieces never reorder or get removed.
              key={i}
              className="confetti-piece"
              style={{
                left: `${left}%`,
                background: color,
                ['--confetti-drift' as string]: `${drift}px`,
                ['--confetti-delay' as string]: `${delay}ms`,
                ['--confetti-spin' as string]: `${spin}deg`,
              }}
            />
          )
        })}
      </div>

      {/* Center card */}
      <div className="rise-in island-shell mx-4 max-w-xs rounded-2xl px-6 py-5 text-center shadow-xl">
        <div className="text-4xl" aria-hidden>
          {event.glyph}
        </div>
        <p className="mt-2 text-lg font-bold text-[var(--sea-ink)]">{event.title}</p>
        <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">{event.subtitle}</p>
      </div>
    </div>
  )
}
