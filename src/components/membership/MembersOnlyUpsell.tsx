// Shared upgrade prompt rendered when a free user clicks a locked
// feature (member-only arcade game, premium coach attitude, garden, …).
// Two buttons: Annual subscription and Lifetime one-time. Both kick off
// a Stripe Checkout session and redirect the browser.
//
// Live amounts are fetched from Stripe via getPricingDisplayFn so we
// never hardcode dollars. While loading, the buttons show a spinner
// label rather than a stale price.
import { useEffect } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  createAnnualCheckoutFn,
  createLifetimeCheckoutFn,
  getPricingDisplayFn,
} from '../../server/functions/billing'

export function formatMoney(
  amount: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (amount == null || !currency) return '—'
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: amount % 100 === 0 ? 0 : 2,
    }).format(amount / 100)
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`
  }
}

interface UpsellProps {
  open: boolean
  onClose: () => void
  // Short headline shown above the two checkout buttons. Tells the user
  // *why* they hit the modal (e.g. "Wordle is a members game").
  headline: string
  subline?: string
}

export function MembersOnlyUpsell({
  open,
  onClose,
  headline,
  subline,
}: UpsellProps) {
  const pricing = useQuery({
    queryKey: ['pricing-display'],
    queryFn: () => getPricingDisplayFn(),
    enabled: open,
    staleTime: 60_000,
  })

  const annual = useMutation({
    mutationFn: () => createAnnualCheckoutFn(),
    onSuccess: ({ url }) => {
      window.location.assign(url)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Could not start checkout'),
  })

  const lifetime = useMutation({
    mutationFn: () => createLifetimeCheckoutFn(),
    onSuccess: ({ url }) => {
      window.location.assign(url)
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Could not start checkout'),
  })

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const annualLabel = pricing.data?.annual
    ? `${formatMoney(pricing.data.annual.amount, pricing.data.annual.currency)}/${pricing.data.annual.interval}`
    : '…'
  const lifetimeLabel = pricing.data?.lifetime
    ? `${formatMoney(pricing.data.lifetime.amount, pricing.data.lifetime.currency)} once`
    : '…'

  const pending = annual.isPending || lifetime.isPending

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Upgrade to members"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="island-shell w-full max-w-md rounded-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="island-kicker mb-1">Members</p>
        <h2 className="display-title mb-1 text-xl font-bold text-[var(--sea-ink)]">
          {headline}
        </h2>
        {subline ? (
          <p className="mb-4 text-sm text-[var(--sea-ink-soft)]">{subline}</p>
        ) : (
          <p className="mb-4 text-sm text-[var(--sea-ink-soft)]">
            Membership unlocks the full arcade, the AI Coach personalities and
            detailed mode, and the Garden.
          </p>
        )}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => annual.mutate()}
            disabled={pending || pricing.isLoading}
            className="rounded-full bg-[var(--btn-primary-bg)] px-5 py-2.5 text-sm font-semibold text-[var(--btn-primary-fg)] disabled:opacity-50"
          >
            {annual.isPending
              ? 'Redirecting…'
              : `Annual · ${annualLabel}`}
          </button>
          <button
            type="button"
            onClick={() => lifetime.mutate()}
            disabled={pending || pricing.isLoading}
            className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-50"
          >
            {lifetime.isPending
              ? 'Redirecting…'
              : `Lifetime · ${lifetimeLabel}`}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="mt-1 rounded-full px-5 py-2 text-xs font-semibold text-[var(--sea-ink-soft)]"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}
