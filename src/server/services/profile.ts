// Public profile aggregation. Fetches the identity + progression + a rolling
// XP history for a given handle, respecting privacy (canView) and blocks.
// The viewer's relation to the target is included so the UI can render the
// right action buttons without another round-trip.
import { and, eq, gte, isNotNull, or, sql } from 'drizzle-orm'
import { db } from '../db/client'
import {
  events,
  friendships,
  progression,
  user as userTable,
} from '../db/schema'
import { canView } from './social'
import { normalizeHandle } from './handles'

export type ViewerRelation =
  | 'self'
  | 'friend'
  | 'outgoing_request'
  | 'incoming_request'
  | 'blocked_by_me'
  | 'blocked_me'
  | 'none'

export interface PublicProfile {
  userId: string
  handle: string
  name: string
  profileVisibility: 'public' | 'friends' | 'private'
  canView: boolean
  viewerRelation: ViewerRelation
  progression: {
    xp: number
    level: number
    currentStreak: number
    longestStreak: number
  } | null
  xpByDay: Array<{ date: string; xp: number }>
}

const WINDOW_DAYS = 30

export async function getPublicProfile(
  viewerId: string,
  handle: string,
): Promise<PublicProfile | null> {
  const normalized = normalizeHandle(handle)
  if (!normalized) return null

  const target = await db.query.user.findFirst({
    where: sql`lower(${userTable.handle}) = lower(${normalized})`,
  })
  if (!target) return null

  const relation = await resolveRelation(viewerId, target.id)
  const visible = await canView(viewerId, target.id)

  if (!visible) {
    return {
      userId: target.id,
      handle: target.handle,
      name: target.name,
      profileVisibility: target.profileVisibility,
      canView: false,
      viewerRelation: relation,
      progression: null,
      xpByDay: [],
    }
  }

  const [prog, xpByDay] = await Promise.all([
    loadProgression(target.id),
    loadXpSeries(target.id, target.timezone),
  ])

  return {
    userId: target.id,
    handle: target.handle,
    name: target.name,
    profileVisibility: target.profileVisibility,
    canView: true,
    viewerRelation: relation,
    progression: prog,
    xpByDay,
  }
}

async function resolveRelation(
  viewerId: string,
  targetId: string,
): Promise<ViewerRelation> {
  if (viewerId === targetId) return 'self'
  const row = await db.query.friendships.findFirst({
    where: or(
      and(
        eq(friendships.requesterId, viewerId),
        eq(friendships.addresseeId, targetId),
      ),
      and(
        eq(friendships.requesterId, targetId),
        eq(friendships.addresseeId, viewerId),
      ),
    ),
  })
  if (!row) return 'none'
  if (row.status === 'accepted') return 'friend'
  if (row.status === 'blocked') {
    return row.requesterId === viewerId ? 'blocked_by_me' : 'blocked_me'
  }
  // pending
  return row.requesterId === viewerId ? 'outgoing_request' : 'incoming_request'
}

async function loadProgression(userId: string): Promise<{
  xp: number
  level: number
  currentStreak: number
  longestStreak: number
}> {
  const row = await db.query.progression.findFirst({
    where: eq(progression.userId, userId),
  })
  return {
    xp: row?.xp ?? 0,
    level: row?.level ?? 1,
    currentStreak: row?.currentStreak ?? 0,
    longestStreak: row?.longestStreak ?? 0,
  }
}

async function loadXpSeries(
  userId: string,
  timeZone: string,
): Promise<Array<{ date: string; xp: number }>> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3_600_000)
  const rows = await db
    .select({
      payload: events.payload,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.type, 'task.completed'),
        isNotNull(events.occurredAt),
        gte(events.occurredAt, since),
      ),
    )

  const dayFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const totals = new Map<string, number>()
  for (const r of rows) {
    if (!r.occurredAt) continue
    const p =
      r.payload && typeof r.payload === 'object'
        ? (r.payload as Record<string, unknown>)
        : {}
    const xpOverride =
      typeof p['xpOverride'] === 'number'
        ? (p['xpOverride'] as number)
        : null
    const difficulty =
      typeof p['difficulty'] === 'string' ? p['difficulty'] : null
    const xp =
      xpOverride ??
      (difficulty === 'small' ? 10 : difficulty === 'large' ? 60 : 25)
    const key = dayFmt.format(r.occurredAt)
    totals.set(key, (totals.get(key) ?? 0) + xp)
  }
  const series: Array<{ date: string; xp: number }> = []
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 3_600_000)
    const key = dayFmt.format(d)
    series.push({ date: key, xp: totals.get(key) ?? 0 })
  }
  return series
}
