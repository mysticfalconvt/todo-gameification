import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { startDoomScroll } from '../server/functions/doomscroll'
import {
  DOOMSCROLL_DURATIONS,
  DOOMSCROLL_TOKEN_COST,
  DOOMSCROLL_XP,
  type DoomScrollDurationMin,
} from '../domain/events'

// Icon-only "doom scroll" break-timer entry point. Sits next to New/Focus
// on /today but stays icon-width (no flex-1) so it never spans the row on
// mobile. Opens a dialog to pick a break length; starting spends a token,
// grants +1 XP, and schedules a "back to work" push for when it's up.
export function DoomScrollButton({ tokens }: { tokens: number }) {
  const qc = useQueryClient()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const [open, setOpen] = useState(false)
  const [duration, setDuration] = useState<DoomScrollDurationMin>(10)

  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (open && !el.open) el.showModal()
    else if (!open && el.open) el.close()
  }, [open])

  const start = useMutation({
    mutationFn: (durationMin: DoomScrollDurationMin) =>
      startDoomScroll({ data: { durationMin } }),
    onSuccess: (_result, durationMin) => {
      qc.invalidateQueries({ queryKey: ['progression'] })
      qc.invalidateQueries({ queryKey: ['recent-activity'] })
      setOpen(false)
      toast.success(
        `Scroll away 💀 We'll ping you in ${durationMin} min. −${DOOMSCROLL_TOKEN_COST}🪙 +${DOOMSCROLL_XP}xp`,
      )
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Could not start timer')
    },
  })

  const canAfford = tokens >= DOOMSCROLL_TOKEN_COST

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Doom scroll break timer"
        title="Doom scroll break timer"
        className="shrink-0 self-end rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-3 py-2 text-center text-base leading-none font-semibold text-[var(--lagoon-deep)] no-underline"
      >
        💀
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === dialogRef.current) setOpen(false)
        }}
        className="m-auto w-[min(420px,calc(100%-1.5rem))] rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-0 text-[var(--sea-ink)] shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
      >
        <div className="flex flex-col gap-4 p-5">
          <div>
            <h3 className="display-title text-lg font-bold text-[var(--sea-ink)]">
              💀 Doom scroll timer
            </h3>
            <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
              Spend a token to goof off guilt-free. We'll ping you when it's
              time to get back to work.
            </p>
          </div>

          <div
            role="radiogroup"
            aria-label="Break duration"
            className="grid grid-cols-4 gap-2"
          >
            {DOOMSCROLL_DURATIONS.map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={duration === d}
                onClick={() => setDuration(d)}
                className={[
                  'rounded-xl border px-1 py-3 text-sm font-semibold transition',
                  duration === d
                    ? 'border-[var(--lagoon-deep)] bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                    : 'border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] text-[var(--sea-ink)] hover:border-[var(--lagoon-deep)]',
                ].join(' ')}
              >
                {d}m
              </button>
            ))}
          </div>

          <p className="text-xs text-[var(--sea-ink-soft)]">
            Costs {DOOMSCROLL_TOKEN_COST}🪙 · earns +{DOOMSCROLL_XP}xp · you have{' '}
            {tokens}🪙
          </p>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-xl border border-[var(--btn-subtle-border)] bg-[var(--btn-subtle-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink)]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canAfford || start.isPending}
              onClick={() => start.mutate(duration)}
              className="rounded-xl bg-[var(--btn-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--btn-primary-fg)] disabled:opacity-50"
            >
              {canAfford ? `Start ${duration}-min break` : 'Not enough tokens'}
            </button>
          </div>
        </div>
      </dialog>
    </>
  )
}
