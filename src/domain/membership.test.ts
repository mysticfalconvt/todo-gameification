import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent } from './events'
import {
  INITIAL_MEMBERSHIP,
  applyMembershipEvent,
  isMember,
  replayMembershipEvents,
} from './membership'

const at = (iso: string) => new Date(iso)

describe('membership.trial_started', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(at('2026-05-13T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('marks the user as a member while the trial is unexpired', () => {
    const trialEndsAt = at('2026-05-23T12:00:00Z')
    const state = applyMembershipEvent(INITIAL_MEMBERSHIP, {
      type: 'membership.trial_started',
      trialEndsAt,
      occurredAt: at('2026-05-13T12:00:00Z'),
    })

    expect(state.tier).toBe('trial')
    expect(state.status).toBe('active')
    expect(state.source).toBe('system')
    expect(state.currentPeriodEnd).toEqual(trialEndsAt)
    expect(isMember(state)).toBe(true)
  })

  it('drops to non-member once the trial expires (lazy compute)', () => {
    const trialEndsAt = at('2026-05-23T12:00:00Z')
    const state = applyMembershipEvent(INITIAL_MEMBERSHIP, {
      type: 'membership.trial_started',
      trialEndsAt,
      occurredAt: at('2026-05-13T12:00:00Z'),
    })

    vi.setSystemTime(at('2026-05-24T12:00:00Z'))
    // Projection row still reads 'trial' — entitlement flips via isMember().
    expect(state.tier).toBe('trial')
    expect(isMember(state)).toBe(false)
  })
})

describe('trial → paid replay determinism', () => {
  it('activation after a trial wins (annual)', () => {
    const events: DomainEvent[] = [
      {
        type: 'membership.trial_started',
        trialEndsAt: at('2026-05-23T12:00:00Z'),
        occurredAt: at('2026-05-13T12:00:00Z'),
      },
      {
        type: 'membership.activated',
        tier: 'annual',
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: 'sub_123',
        currentPeriodEnd: at('2027-05-15T12:00:00Z'),
        stripeEventId: 'evt_1',
        occurredAt: at('2026-05-15T12:00:00Z'),
      },
    ]
    const state = replayMembershipEvents(events)
    expect(state.tier).toBe('annual')
    expect(state.status).toBe('active')
    expect(state.source).toBe('stripe')
    expect(isMember(state)).toBe(true)
  })

  it('lifetime grant on top of a trial replaces the tier', () => {
    const events: DomainEvent[] = [
      {
        type: 'membership.trial_started',
        trialEndsAt: at('2026-05-23T12:00:00Z'),
        occurredAt: at('2026-05-13T12:00:00Z'),
      },
      {
        type: 'membership.granted',
        tier: 'lifetime',
        grantedBy: 'admin-1',
        reason: 'beta-tester',
        occurredAt: at('2026-05-14T12:00:00Z'),
      },
    ]
    const state = replayMembershipEvents(events)
    expect(state.tier).toBe('lifetime')
    expect(isMember(state)).toBe(true)
  })
})
