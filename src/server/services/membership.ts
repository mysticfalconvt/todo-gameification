// Membership service. Single source for "is this user a member?" and the
// helpers that fold events into the projection.
//
// Reads: O(1) by userId against the `memberships` table.
// Writes: always go through `applyMembershipEvent` — webhooks and admin
// actions write the event then upsert the next state in one transaction
// (or rebuild from the full event log via `rebuildMembership`).

import { and, asc, eq, inArray } from 'drizzle-orm'
import type { DomainEvent } from '../../domain/events'
import {
  INITIAL_MEMBERSHIP,
  applyMembershipEvent,
  isMember as isMemberState,
  type MembershipSource,
  type MembershipState,
  type MembershipStatus,
  type MembershipTier,
} from '../../domain/membership'
import { db } from '../db/client'
import { events, memberships } from '../db/schema'

// The set of membership.* event types — used both to filter the event
// log when replaying and to ensure we never persist a non-membership
// event into the projection by accident.
const MEMBERSHIP_EVENT_TYPES = [
  'membership.granted',
  'membership.activated',
  'membership.renewed',
  'membership.cancel_scheduled',
  'membership.lapsed',
  'membership.refunded',
  'membership.revoked',
] as const

export interface MemberStatus {
  tier: MembershipTier
  status: MembershipStatus
  source: MembershipSource
  isMember: boolean
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
}

function rowToStatus(
  row:
    | {
        tier: MembershipTier
        status: MembershipStatus
        source: MembershipSource
        currentPeriodEnd: Date | null
        cancelAtPeriodEnd: boolean
        stripeCustomerId: string | null
        stripeSubscriptionId: string | null
      }
    | null
    | undefined,
): MemberStatus {
  const state: MembershipState = row
    ? {
        tier: row.tier,
        status: row.status,
        source: row.source,
        currentPeriodEnd: row.currentPeriodEnd,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        stripeCustomerId: row.stripeCustomerId,
        stripeSubscriptionId: row.stripeSubscriptionId,
        grantedBy: null,
        grantedAt: null,
      }
    : INITIAL_MEMBERSHIP
  return {
    tier: state.tier,
    status: state.status,
    source: state.source,
    isMember: isMemberState(state),
    currentPeriodEnd: state.currentPeriodEnd,
    cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    stripeCustomerId: state.stripeCustomerId,
    stripeSubscriptionId: state.stripeSubscriptionId,
  }
}

export async function getMemberStatus(userId: string): Promise<MemberStatus> {
  const row = await db.query.memberships.findFirst({
    where: eq(memberships.userId, userId),
  })
  return rowToStatus(row ?? null)
}

export async function requireMember(userId: string): Promise<MemberStatus> {
  const s = await getMemberStatus(userId)
  if (!s.isMember) {
    throw new Response('Members only', { status: 403 })
  }
  return s
}

// Loads ALL membership.* events for a user (oldest first) and returns
// the folded state. Used by `rebuildMembership` and for forensics. The
// volume per user is tiny (a handful of rows over a lifetime) so a full
// scan with a sort is fine.
async function loadMembershipEventsForUser(
  userId: string,
): Promise<DomainEvent[]> {
  const rows = await db
    .select({
      type: events.type,
      payload: events.payload,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        inArray(events.type, [...MEMBERSHIP_EVENT_TYPES]),
      ),
    )
    .orderBy(asc(events.occurredAt))

  return rows.map((r) => deserializeEvent(r.type, r.payload, r.occurredAt))
}

function deserializeEvent(
  type: string,
  payload: unknown,
  occurredAt: Date,
): DomainEvent {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<
    string,
    unknown
  >
  switch (type) {
    case 'membership.granted':
      return {
        type: 'membership.granted',
        tier: p.tier as 'lifetime' | 'annual',
        grantedBy: String(p.grantedBy ?? ''),
        reason: typeof p.reason === 'string' ? p.reason : null,
        occurredAt,
      }
    case 'membership.activated':
      return {
        type: 'membership.activated',
        tier: p.tier as 'annual' | 'lifetime',
        stripeCustomerId:
          typeof p.stripeCustomerId === 'string' && p.stripeCustomerId
            ? p.stripeCustomerId
            : null,
        stripeSubscriptionId:
          typeof p.stripeSubscriptionId === 'string'
            ? p.stripeSubscriptionId
            : null,
        currentPeriodEnd:
          typeof p.currentPeriodEnd === 'string'
            ? new Date(p.currentPeriodEnd)
            : null,
        stripeEventId: String(p.stripeEventId ?? ''),
        occurredAt,
      }
    case 'membership.renewed':
      return {
        type: 'membership.renewed',
        currentPeriodEnd: new Date(String(p.currentPeriodEnd)),
        stripeEventId: String(p.stripeEventId ?? ''),
        occurredAt,
      }
    case 'membership.cancel_scheduled':
      return {
        type: 'membership.cancel_scheduled',
        currentPeriodEnd: new Date(String(p.currentPeriodEnd)),
        stripeEventId: String(p.stripeEventId ?? ''),
        occurredAt,
      }
    case 'membership.lapsed':
      return {
        type: 'membership.lapsed',
        reason: (p.reason as 'period_end' | 'payment_failed' | 'voluntary') ??
          'period_end',
        stripeEventId: String(p.stripeEventId ?? ''),
        occurredAt,
      }
    case 'membership.refunded':
      return {
        type: 'membership.refunded',
        stripeEventId: String(p.stripeEventId ?? ''),
        occurredAt,
      }
    case 'membership.revoked':
      return {
        type: 'membership.revoked',
        revokedBy: String(p.revokedBy ?? ''),
        reason: typeof p.reason === 'string' ? p.reason : null,
        occurredAt,
      }
    default:
      throw new Error(`unknown membership event type: ${type}`)
  }
}

// Rebuilds the projection for a user from their full membership event
// log. Mirrors `rebuildProgression`. Idempotent — call after any state
// change to backfill, or when a webhook handler wants to ensure the
// projection matches the event log.
export async function rebuildMembership(userId: string): Promise<MemberStatus> {
  const events = await loadMembershipEventsForUser(userId)
  let state: MembershipState = INITIAL_MEMBERSHIP
  for (const e of events) {
    state = applyMembershipEvent(state, e)
  }

  if (state === INITIAL_MEMBERSHIP) {
    // Never had a membership event — leave projection clean. Don't insert
    // a free row; getMemberStatus already synthesizes free for missing rows.
    await db.delete(memberships).where(eq(memberships.userId, userId))
    return rowToStatus(null)
  }

  await upsertProjection(userId, state)
  return rowToStatus({
    tier: state.tier,
    status: state.status,
    source: state.source,
    currentPeriodEnd: state.currentPeriodEnd,
    cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    stripeCustomerId: state.stripeCustomerId,
    stripeSubscriptionId: state.stripeSubscriptionId,
  })
}

// Upserts the projection row from an in-memory state. Used by webhook
// handlers and admin grants after they write the event. Caller is
// responsible for running this inside the same transaction as the event
// insert (db.transaction).
export async function upsertProjection(
  userId: string,
  state: MembershipState,
  tx?: typeof db,
): Promise<void> {
  const target = tx ?? db
  await target
    .insert(memberships)
    .values({
      userId,
      tier: state.tier,
      status: state.status,
      source: state.source,
      stripeCustomerId: state.stripeCustomerId,
      stripeSubscriptionId: state.stripeSubscriptionId,
      currentPeriodEnd: state.currentPeriodEnd,
      cancelAtPeriodEnd: state.cancelAtPeriodEnd,
      grantedBy: state.grantedBy,
      grantedAt: state.grantedAt,
    })
    .onConflictDoUpdate({
      target: memberships.userId,
      set: {
        tier: state.tier,
        status: state.status,
        source: state.source,
        stripeCustomerId: state.stripeCustomerId,
        stripeSubscriptionId: state.stripeSubscriptionId,
        currentPeriodEnd: state.currentPeriodEnd,
        cancelAtPeriodEnd: state.cancelAtPeriodEnd,
        grantedBy: state.grantedBy,
        grantedAt: state.grantedAt,
        updatedAt: new Date(),
      },
    })
}

// Loads the current projection state (NOT the synthesized free fallback).
// Webhooks call this to fold the new event onto the prior state.
export async function loadProjectionState(
  userId: string,
): Promise<MembershipState> {
  const row = await db.query.memberships.findFirst({
    where: eq(memberships.userId, userId),
  })
  if (!row) return INITIAL_MEMBERSHIP
  return {
    tier: row.tier,
    status: row.status,
    source: row.source,
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    grantedBy: row.grantedBy,
    grantedAt: row.grantedAt,
  }
}

// Resolve a userId from a Stripe customer id via the projection. Webhook
// handlers call this when the event payload doesn't carry our metadata
// (e.g. a renewal invoice).
export async function findUserIdByStripeCustomerId(
  stripeCustomerId: string,
): Promise<string | null> {
  const row = await db.query.memberships.findFirst({
    where: eq(memberships.stripeCustomerId, stripeCustomerId),
    columns: { userId: true },
  })
  return row?.userId ?? null
}
