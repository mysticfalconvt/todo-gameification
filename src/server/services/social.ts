// Friendship + privacy core. Server functions in src/server/functions/social.ts
// wrap these so business logic stays testable and reusable for leaderboard /
// activity services that also need the privacy gate.
import { and, desc, eq, gt, or, sql } from 'drizzle-orm'
import { db } from '../db/client'
import {
  events,
  friendships,
  progression,
  user as userTable,
  userPrefs,
} from '../db/schema'
import { INITIAL_PROGRESSION, applyEvent } from '../../domain/gamification'
import { sendPushToUser } from '../push/broadcast'
import { normalizeHandle } from './handles'

// Flat XP both sides get when a friendship becomes accepted. One-time per
// pair (see awardFriendshipXp dedupe).
export const FRIEND_ADDED_XP = 25

// Best-effort friend-activity pushes. Swallow errors so the mutation
// always succeeds even when VAPID is unconfigured or the recipient has
// no devices — they'll still see the badge in /friends.
async function fireSocialPush(
  userId: string,
  title: string,
  body: string,
  tag: string,
): Promise<void> {
  try {
    await sendPushToUser(userId, { title, body, tag, url: '/friends' })
  } catch (err) {
    console.error('[social] push failed:', err)
  }
}

async function loadDisplayName(
  userId: string,
): Promise<{ name: string; handle: string } | null> {
  const row = await db.query.user.findFirst({
    where: eq(userTable.id, userId),
    columns: { name: true, handle: true },
  })
  return row ?? null
}

// Insert a friend.added event for `userId` naming `otherUserId`, and apply
// its XP bump to their progression. Idempotent: if the user already has a
// friend.added event for this pair, it no-ops. Protects against unfriend +
// refriend cycles farming XP.
async function grantFriendXpForSide(
  userId: string,
  otherUserId: string,
): Promise<void> {
  const existing = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.type, 'friend.added'),
        sql`${events.payload}->>'otherUserId' = ${otherUserId}`,
      ),
    )
    .limit(1)
  if (existing.length > 0) return

  const now = new Date()
  await db.transaction(async (tx) => {
    await tx.insert(events).values({
      userId,
      type: 'friend.added',
      payload: { otherUserId, xp: FRIEND_ADDED_XP },
      occurredAt: now,
    })
    const current = await tx.query.progression.findFirst({
      where: eq(progression.userId, userId),
    })
    const prevState = current
      ? {
          xp: current.xp,
          level: current.level,
          currentStreak: current.currentStreak,
          longestStreak: current.longestStreak,
          tokens: current.tokens,
          lastCompletionAt: current.lastCompletionAt,
        }
      : INITIAL_PROGRESSION
    const next = applyEvent(
      prevState,
      {
        type: 'friend.added',
        otherUserId,
        xp: FRIEND_ADDED_XP,
        occurredAt: now,
      },
      // timeZone isn't consulted for friend.added, so UTC is fine.
      { timeZone: 'UTC' },
    )
    await tx
      .insert(progression)
      .values({
        userId,
        xp: next.xp,
        level: next.level,
        currentStreak: next.currentStreak,
        longestStreak: next.longestStreak,
        tokens: next.tokens,
        lastCompletionAt: next.lastCompletionAt,
      })
      .onConflictDoUpdate({
        target: progression.userId,
        set: { xp: next.xp, level: next.level, updatedAt: now },
      })
  })
}

// Award friendship XP to both sides. Best-effort — errors are logged but
// never break the acceptance flow.
async function awardFriendshipXp(
  userIdA: string,
  userIdB: string,
): Promise<void> {
  try {
    await Promise.all([
      grantFriendXpForSide(userIdA, userIdB),
      grantFriendXpForSide(userIdB, userIdA),
    ])
  } catch (err) {
    console.error('[social] awardFriendshipXp failed:', err)
  }
}

export type FriendshipStatus = 'pending' | 'accepted' | 'blocked'

export interface FriendRow {
  userId: string
  handle: string
  name: string
  profileVisibility: 'public' | 'friends' | 'private'
  since: Date
}

export interface PendingRow {
  userId: string
  handle: string
  name: string
  createdAt: Date
}

// Rate limit for outgoing friend requests (anti-spam).
const MAX_REQUESTS_PER_DAY = 30

export async function resolveUserByHandle(
  handle: string,
): Promise<{ id: string; handle: string; name: string } | null> {
  const normalized = normalizeHandle(handle)
  if (!normalized) return null
  const row = await db
    .select({ id: userTable.id, handle: userTable.handle, name: userTable.name })
    .from(userTable)
    .where(sql`lower(${userTable.handle}) = lower(${normalized})`)
    .limit(1)
  return row[0] ?? null
}

async function findFriendshipEitherDirection(
  a: string,
  b: string,
): Promise<typeof friendships.$inferSelect | null> {
  const rows = await db
    .select()
    .from(friendships)
    .where(
      or(
        and(
          eq(friendships.requesterId, a),
          eq(friendships.addresseeId, b),
        ),
        and(
          eq(friendships.requesterId, b),
          eq(friendships.addresseeId, a),
        ),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

export interface SendRequestResult {
  status: 'sent' | 'accepted' | 'already_pending' | 'already_friends'
  otherUserId: string
}

export async function sendFriendRequest(
  meId: string,
  targetHandle: string,
): Promise<SendRequestResult> {
  const target = await resolveUserByHandle(targetHandle)
  if (!target) throw new Error('No user with that handle.')
  if (target.id === meId) throw new Error("You can't friend yourself.")

  const recentCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(friendships)
    .where(
      and(
        eq(friendships.requesterId, meId),
        gt(
          friendships.createdAt,
          new Date(Date.now() - 24 * 60 * 60 * 1000),
        ),
      ),
    )
  if ((recentCount[0]?.count ?? 0) >= MAX_REQUESTS_PER_DAY) {
    throw new Error('Friend request limit reached. Try again tomorrow.')
  }

  const existing = await findFriendshipEitherDirection(meId, target.id)
  if (existing) {
    if (existing.status === 'blocked') {
      // Don't leak which side blocked — just refuse with a neutral error.
      throw new Error('Unable to send a request to this user.')
    }
    if (existing.status === 'accepted') {
      return { status: 'already_friends', otherUserId: target.id }
    }
    // pending
    if (
      existing.requesterId === target.id &&
      existing.addresseeId === meId
    ) {
      // They already sent me one — accept it instead of sending a new one.
      await db
        .update(friendships)
        .set({ status: 'accepted', respondedAt: new Date() })
        .where(
          and(
            eq(friendships.requesterId, target.id),
            eq(friendships.addresseeId, meId),
          ),
        )
      await awardFriendshipXp(meId, target.id)
      // Notify the original requester that we just accepted their request.
      const me = await loadDisplayName(meId)
      if (me) {
        await fireSocialPush(
          target.id,
          `${me.name} accepted your friend request`,
          `You’re now friends.`,
          `friend-accept-${meId}`,
        )
      }
      return { status: 'accepted', otherUserId: target.id }
    }
    return { status: 'already_pending', otherUserId: target.id }
  }

  await db.insert(friendships).values({
    requesterId: meId,
    addresseeId: target.id,
    status: 'pending',
  })
  const me = await loadDisplayName(meId)
  if (me) {
    await fireSocialPush(
      target.id,
      `New friend request`,
      `${me.name} (@${me.handle}) wants to connect.`,
      `friend-request-${meId}`,
    )
  }
  return { status: 'sent', otherUserId: target.id }
}

export async function acceptFriendRequest(
  meId: string,
  requesterId: string,
): Promise<void> {
  const res = await db
    .update(friendships)
    .set({ status: 'accepted', respondedAt: new Date() })
    .where(
      and(
        eq(friendships.requesterId, requesterId),
        eq(friendships.addresseeId, meId),
        eq(friendships.status, 'pending'),
      ),
    )
    .returning({ requesterId: friendships.requesterId })
  if (res.length === 0) {
    throw new Error('No pending request from that user.')
  }
  await awardFriendshipXp(meId, requesterId)
  // Let the requester know their request landed.
  const me = await loadDisplayName(meId)
  if (me) {
    await fireSocialPush(
      requesterId,
      `${me.name} accepted your friend request`,
      `You’re now friends.`,
      `friend-accept-${meId}`,
    )
  }
}

export async function declineFriendRequest(
  meId: string,
  requesterId: string,
): Promise<void> {
  await db
    .delete(friendships)
    .where(
      and(
        eq(friendships.requesterId, requesterId),
        eq(friendships.addresseeId, meId),
        eq(friendships.status, 'pending'),
      ),
    )
}

// Cancel an outgoing request I sent.
export async function cancelFriendRequest(
  meId: string,
  addresseeId: string,
): Promise<void> {
  await db
    .delete(friendships)
    .where(
      and(
        eq(friendships.requesterId, meId),
        eq(friendships.addresseeId, addresseeId),
        eq(friendships.status, 'pending'),
      ),
    )
}

export async function removeFriend(
  meId: string,
  otherId: string,
): Promise<void> {
  await db
    .delete(friendships)
    .where(
      and(
        or(
          and(
            eq(friendships.requesterId, meId),
            eq(friendships.addresseeId, otherId),
          ),
          and(
            eq(friendships.requesterId, otherId),
            eq(friendships.addresseeId, meId),
          ),
        ),
        eq(friendships.status, 'accepted'),
      ),
    )
}

export async function blockUser(meId: string, targetId: string): Promise<void> {
  if (meId === targetId) throw new Error("You can't block yourself.")
  // Clear any existing rows between us first.
  await db
    .delete(friendships)
    .where(
      or(
        and(
          eq(friendships.requesterId, meId),
          eq(friendships.addresseeId, targetId),
        ),
        and(
          eq(friendships.requesterId, targetId),
          eq(friendships.addresseeId, meId),
        ),
      ),
    )
  await db.insert(friendships).values({
    requesterId: meId,
    addresseeId: targetId,
    status: 'blocked',
    respondedAt: new Date(),
  })
}

export async function unblockUser(
  meId: string,
  targetId: string,
): Promise<void> {
  await db
    .delete(friendships)
    .where(
      and(
        eq(friendships.requesterId, meId),
        eq(friendships.addresseeId, targetId),
        eq(friendships.status, 'blocked'),
      ),
    )
}

export async function listFriends(meId: string): Promise<FriendRow[]> {
  const rows = await db
    .select({
      f: friendships,
      u: {
        id: userTable.id,
        handle: userTable.handle,
        name: userTable.name,
        profileVisibility: userTable.profileVisibility,
      },
    })
    .from(friendships)
    .innerJoin(
      userTable,
      or(
        and(
          eq(friendships.requesterId, meId),
          eq(userTable.id, friendships.addresseeId),
        ),
        and(
          eq(friendships.addresseeId, meId),
          eq(userTable.id, friendships.requesterId),
        ),
      ),
    )
    .where(eq(friendships.status, 'accepted'))
    .orderBy(desc(friendships.respondedAt))

  return rows.map((r) => ({
    userId: r.u.id,
    handle: r.u.handle,
    name: r.u.name,
    profileVisibility: r.u.profileVisibility,
    since: r.f.respondedAt ?? r.f.createdAt,
  }))
}

export async function listIncomingRequests(meId: string): Promise<PendingRow[]> {
  const rows = await db
    .select({
      createdAt: friendships.createdAt,
      id: userTable.id,
      handle: userTable.handle,
      name: userTable.name,
    })
    .from(friendships)
    .innerJoin(userTable, eq(userTable.id, friendships.requesterId))
    .where(
      and(
        eq(friendships.addresseeId, meId),
        eq(friendships.status, 'pending'),
      ),
    )
    .orderBy(desc(friendships.createdAt))
  return rows.map((r) => ({
    userId: r.id,
    handle: r.handle,
    name: r.name,
    createdAt: r.createdAt,
  }))
}

export async function listOutgoingRequests(meId: string): Promise<PendingRow[]> {
  const rows = await db
    .select({
      createdAt: friendships.createdAt,
      id: userTable.id,
      handle: userTable.handle,
      name: userTable.name,
    })
    .from(friendships)
    .innerJoin(userTable, eq(userTable.id, friendships.addresseeId))
    .where(
      and(
        eq(friendships.requesterId, meId),
        eq(friendships.status, 'pending'),
      ),
    )
    .orderBy(desc(friendships.createdAt))
  return rows.map((r) => ({
    userId: r.id,
    handle: r.handle,
    name: r.name,
    createdAt: r.createdAt,
  }))
}

export async function listBlocked(meId: string): Promise<FriendRow[]> {
  const rows = await db
    .select({
      f: friendships,
      u: {
        id: userTable.id,
        handle: userTable.handle,
        name: userTable.name,
        profileVisibility: userTable.profileVisibility,
      },
    })
    .from(friendships)
    .innerJoin(userTable, eq(userTable.id, friendships.addresseeId))
    .where(
      and(
        eq(friendships.requesterId, meId),
        eq(friendships.status, 'blocked'),
      ),
    )
  return rows.map((r) => ({
    userId: r.u.id,
    handle: r.u.handle,
    name: r.u.name,
    profileVisibility: r.u.profileVisibility,
    since: r.f.respondedAt ?? r.f.createdAt,
  }))
}

// Privacy gate shared by profile, activity feed, and leaderboards.
export async function canView(
  viewerId: string,
  targetId: string,
): Promise<boolean> {
  if (viewerId === targetId) return true
  const target = await db.query.user.findFirst({
    where: eq(userTable.id, targetId),
    columns: { profileVisibility: true },
  })
  if (!target) return false
  // If target blocks the viewer, hide.
  const block = await db.query.friendships.findFirst({
    where: and(
      eq(friendships.requesterId, targetId),
      eq(friendships.addresseeId, viewerId),
      eq(friendships.status, 'blocked'),
    ),
  })
  if (block) return false
  if (target.profileVisibility === 'public') return true
  if (target.profileVisibility === 'private') return false
  // 'friends' — must have an accepted friendship either direction.
  const f = await findFriendshipEitherDirection(viewerId, targetId)
  return f?.status === 'accepted'
}

// Load another user's effective sharing prefs (with defaults when no row).
export async function loadPrefs(userId: string): Promise<{
  shareProgression: boolean
  shareActivity: boolean
  shareTaskTitles: boolean
}> {
  const row = await db.query.userPrefs.findFirst({
    where: eq(userPrefs.userId, userId),
  })
  return {
    shareProgression: row?.shareProgression ?? true,
    shareActivity: row?.shareActivity ?? true,
    shareTaskTitles: row?.shareTaskTitles ?? false,
  }
}
