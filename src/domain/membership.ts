// Pure reducer for membership state. Mirrors `gamification.ts:applyEvent`
// — the membership projection in `memberships` is rebuilt by replaying
// every membership.* event for a user through this reducer. Webhooks
// fold the next event into the current state and upsert the row.
import type { DomainEvent } from './events'

export type MembershipTier = 'free' | 'annual' | 'lifetime'
export type MembershipStatus =
  | 'active'
  | 'canceled'
  | 'past_due'
  | 'lapsed'
  | 'none'
export type MembershipSource = 'stripe' | 'admin' | 'none'

export interface MembershipState {
  tier: MembershipTier
  status: MembershipStatus
  source: MembershipSource
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  grantedBy: string | null
  grantedAt: Date | null
}

export const INITIAL_MEMBERSHIP: MembershipState = {
  tier: 'free',
  status: 'none',
  source: 'none',
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  grantedBy: null,
  grantedAt: null,
}

// Returns true when the user currently has any non-free entitlement —
// includes annual that's active OR scheduled-to-cancel-but-not-yet-lapsed,
// and any lifetime row.
export function isMember(state: MembershipState): boolean {
  if (state.tier === 'lifetime') return true
  if (state.tier === 'annual')
    return state.status === 'active' || state.status === 'canceled'
  return false
}

export function applyMembershipEvent(
  state: MembershipState,
  event: DomainEvent,
): MembershipState {
  switch (event.type) {
    case 'membership.granted':
      // Admin grant retains a stripeCustomerId if one already existed
      // (e.g. user had a past Stripe sub and is now being given lifetime).
      return {
        ...state,
        tier: event.tier,
        status: 'active',
        source: 'admin',
        stripeSubscriptionId: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        grantedBy: event.grantedBy,
        grantedAt: event.occurredAt,
      }

    case 'membership.activated':
      return {
        ...state,
        tier: event.tier,
        status: 'active',
        source: 'stripe',
        stripeCustomerId: event.stripeCustomerId,
        stripeSubscriptionId: event.stripeSubscriptionId,
        currentPeriodEnd: event.currentPeriodEnd,
        cancelAtPeriodEnd: false,
        // Activate clears any prior admin grant attribution — they paid.
        grantedBy: null,
        grantedAt: null,
      }

    case 'membership.renewed':
      return {
        ...state,
        status: 'active',
        currentPeriodEnd: event.currentPeriodEnd,
        cancelAtPeriodEnd: false,
      }

    case 'membership.cancel_scheduled':
      return {
        ...state,
        status: 'canceled',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: event.currentPeriodEnd,
      }

    case 'membership.lapsed':
    case 'membership.refunded':
      // Drop entitlement but keep stripeCustomerId so a re-subscription
      // attaches back to the same Stripe customer.
      return {
        ...state,
        tier: 'free',
        status: 'lapsed',
        source: 'none',
        stripeSubscriptionId: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        grantedBy: null,
        grantedAt: null,
      }

    case 'membership.revoked':
      return {
        ...INITIAL_MEMBERSHIP,
        // Preserve stripeCustomerId in case a stripe-sourced row was
        // later admin-granted; revoke is currently UI-disabled for those
        // but keeping the customer id is harmless and forward-safe.
        stripeCustomerId: state.stripeCustomerId,
      }

    default:
      return state
  }
}

export function replayMembershipEvents(
  events: ReadonlyArray<DomainEvent>,
): MembershipState {
  let state: MembershipState = INITIAL_MEMBERSHIP
  for (const e of events) {
    state = applyMembershipEvent(state, e)
  }
  return state
}
