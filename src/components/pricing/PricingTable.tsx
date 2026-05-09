// Three-column comparison table: Free / Annual / Lifetime. Rendered on
// the public /pricing route, embedded in the landing page for logged-out
// visitors, and reused inside the upsell sheet's underlying details.
//
// Real prices come from Stripe via getPricingDisplayFn so changing
// pricing doesn't require a code edit.
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { toast } from 'sonner'
import {
  createAnnualCheckoutFn,
  createLifetimeCheckoutFn,
  getMemberStatusFn,
  getPricingDisplayFn,
} from '../../server/functions/billing'
import { formatMoney } from '../membership/MembersOnlyUpsell'

interface RowSpec {
  label: string
  free: string
  member: string
}

const ROWS: ReadonlyArray<RowSpec> = [
  {
    label: 'AI Coach',
    free: 'Warm voice, concise',
    member: 'All 5 voices, detailed mode',
  },
  {
    label: 'Arcade',
    free: 'Memory Flip, Sliding Puzzle',
    member: 'Wordle, 2048, Word Search + free games',
  },
  { label: 'Garden', free: '—', member: 'Full' },
  { label: 'XP, streaks, focus', free: 'Yes', member: 'Yes' },
  { label: 'Friends + leaderboards', free: 'Yes', member: 'Yes' },
]

interface Props {
  // When true, shows a public-visitor "Sign up to upgrade" CTA.
  // When false, assumes the user is logged in and renders Upgrade buttons
  // that kick off Stripe Checkout directly.
  publicVariant: boolean
}

export function PricingTable({ publicVariant }: Props) {
  const pricing = useQuery({
    queryKey: ['pricing-display'],
    queryFn: () => getPricingDisplayFn(),
    staleTime: 60_000,
  })

  // Member status only matters for the logged-in variant. Skipping it on
  // the public marketing page avoids a wasted (failing) auth call.
  const member = useQuery({
    queryKey: ['member-status'],
    queryFn: () => getMemberStatusFn(),
    enabled: !publicVariant,
  })

  const annual = useMutation({
    mutationFn: () => createAnnualCheckoutFn(),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Could not start checkout'),
  })
  const lifetime = useMutation({
    mutationFn: () => createLifetimeCheckoutFn(),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : 'Could not start checkout'),
  })

  const a = pricing.data?.annual
  const l = pricing.data?.lifetime
  const annualPrice = a ? formatMoney(a.amount, a.currency) : '—'
  const lifetimePrice = l ? formatMoney(l.amount, l.currency) : '—'
  const annualUnit = a ? `/${a.interval}` : ''

  const isMember = member.data?.isMember ?? false
  const memberTier = member.data?.tier ?? 'free'

  return (
    <section className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Free" subtitle="$0" hint="No card, no expiry">
          <ul className="space-y-1.5 text-sm text-[var(--sea-ink)]">
            {ROWS.map((r) => (
              <li key={r.label}>
                <span className="font-semibold">{r.label}:</span>{' '}
                <span className="text-[var(--sea-ink-soft)]">{r.free}</span>
              </li>
            ))}
          </ul>
          {publicVariant ? (
            <Link to="/auth/signup" className="btn-primary mt-4 inline-block">
              Create account
            </Link>
          ) : (
            <p className="mt-4 text-xs text-[var(--sea-ink-soft)]">
              You're on Free.
            </p>
          )}
        </Card>

        <Card
          title="Annual"
          subtitle={`${annualPrice}${annualUnit}`}
          hint="Cancel anytime in Stripe portal"
          highlight
        >
          <ul className="space-y-1.5 text-sm text-[var(--sea-ink)]">
            {ROWS.map((r) => (
              <li key={r.label}>
                <span className="font-semibold">{r.label}:</span>{' '}
                <span className="text-[var(--sea-ink-soft)]">{r.member}</span>
              </li>
            ))}
          </ul>
          {publicVariant ? (
            <Link
              to="/auth/signup"
              className="btn-primary mt-4 inline-block"
            >
              Sign up to upgrade
            </Link>
          ) : memberTier === 'lifetime' ? (
            <p className="mt-4 text-xs text-[var(--sea-ink-soft)]">
              You already have lifetime ✨
            </p>
          ) : isMember ? (
            <p className="mt-4 text-xs text-[var(--sea-ink-soft)]">
              You're already an annual member.
            </p>
          ) : (
            <button
              type="button"
              onClick={() => annual.mutate()}
              disabled={annual.isPending || pricing.isLoading}
              className="btn-primary mt-4 disabled:opacity-50"
            >
              {annual.isPending ? 'Redirecting…' : 'Upgrade to annual'}
            </button>
          )}
        </Card>

        <Card
          title="Lifetime"
          subtitle={lifetimePrice}
          hint="One-time payment, never expires"
        >
          <ul className="space-y-1.5 text-sm text-[var(--sea-ink)]">
            {ROWS.map((r) => (
              <li key={r.label}>
                <span className="font-semibold">{r.label}:</span>{' '}
                <span className="text-[var(--sea-ink-soft)]">{r.member}</span>
              </li>
            ))}
            <li className="text-[var(--sea-ink-soft)]">
              <span aria-hidden>✨ </span>Founder badge
            </li>
          </ul>
          {publicVariant ? (
            <Link
              to="/auth/signup"
              className="mt-4 inline-block rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] no-underline"
            >
              Sign up to upgrade
            </Link>
          ) : memberTier === 'lifetime' ? (
            <p className="mt-4 text-xs text-[var(--sea-ink-soft)]">
              You already have lifetime ✨
            </p>
          ) : (
            <button
              type="button"
              onClick={() => lifetime.mutate()}
              disabled={lifetime.isPending || pricing.isLoading}
              className="mt-4 rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] disabled:opacity-50"
            >
              {lifetime.isPending ? 'Redirecting…' : 'Buy lifetime'}
            </button>
          )}
        </Card>
      </div>
      <p className="text-center text-xs text-[var(--sea-ink-soft)]">
        Payments handled by Stripe. We never see your card details.
      </p>
    </section>
  )
}

function Card({
  title,
  subtitle,
  hint,
  highlight,
  children,
}: {
  title: string
  subtitle: string
  hint: string
  highlight?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={`island-shell flex flex-col gap-3 rounded-2xl p-5 ${
        highlight ? 'border-[var(--lagoon-deep)] ring-2 ring-[rgba(50,143,151,0.25)]' : ''
      }`}
    >
      <header>
        <p className="island-kicker mb-1">{title}</p>
        <p className="display-title text-3xl font-bold text-[var(--sea-ink)]">
          {subtitle}
        </p>
        <p className="text-xs text-[var(--sea-ink-soft)]">{hint}</p>
      </header>
      {children}
    </div>
  )
}
