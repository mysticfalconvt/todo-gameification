import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { events, user } from '../db/schema'
import { withTestUser, withTestUsers } from '../../test/helpers'
import { acceptFriendRequest, sendFriendRequest } from './social'
import { getLeaderboard } from './leaderboard'

// Contract tests for src/server/services/leaderboard.ts. Seeds events
// directly so we don't depend on the task service's LLM calls.

function seedCompletion(
  userId: string,
  opts: { difficulty?: 'small' | 'medium' | 'large'; xp?: number; when?: Date } = {},
) {
  return db.insert(events).values({
    userId,
    type: 'task.completed',
    payload: {
      taskId: 'dummy',
      instanceId: 'dummy',
      difficulty: opts.difficulty ?? 'medium',
      ...(opts.xp != null ? { xpOverride: opts.xp } : {}),
    },
    occurredAt: opts.when ?? new Date(),
  })
}

describe('leaderboard service', () => {
  it('friends scope includes viewer + accepted friends', async () => {
    await withTestUsers(3, async ([me, friend, stranger]) => {
      await sendFriendRequest(me.id, friend.handle)
      await acceptFriendRequest(friend.id, me.id)
      await seedCompletion(me.id, { difficulty: 'small' })
      await seedCompletion(friend.id, { difficulty: 'large' })
      await seedCompletion(stranger.id, { difficulty: 'large' })

      const rows = await getLeaderboard(me.id, {
        scope: 'friends',
        metric: 'xp',
        days: 7,
      })
      const ids = rows.map((r) => r.userId)
      expect(ids).toContain(me.id)
      expect(ids).toContain(friend.id)
      expect(ids).not.toContain(stranger.id)
      // Friend did the 'large' completion (60 XP default); should rank above me.
      const friendRow = rows.find((r) => r.userId === friend.id)!
      const myRow = rows.find((r) => r.userId === me.id)!
      expect(friendRow.value).toBeGreaterThan(myRow.value)
      expect(friendRow.rank).toBeLessThan(myRow.rank)
    })
  })

  it('global scope includes public users but not friends-only strangers', async () => {
    await withTestUsers(3, async ([me, pub, hidden]) => {
      await db
        .update(user)
        .set({ profileVisibility: 'public' })
        .where(eq(user.id, pub.id))
      // `hidden` stays at the default 'friends' visibility.
      await seedCompletion(pub.id, { difficulty: 'large' })
      await seedCompletion(hidden.id, { difficulty: 'large' })

      const rows = await getLeaderboard(me.id, {
        scope: 'global',
        metric: 'xp',
        days: 7,
      })
      const ids = rows.map((r) => r.userId)
      expect(ids).toContain(me.id)
      expect(ids).toContain(pub.id)
      expect(ids).not.toContain(hidden.id)
    })
  })

  it('showed-up metric counts distinct local days, not raw events', async () => {
    await withTestUser(async (u) => {
      const now = Date.now()
      // Three events, two different days.
      await seedCompletion(u.id, { when: new Date(now) })
      await seedCompletion(u.id, { when: new Date(now - 1_000) })
      await seedCompletion(u.id, {
        when: new Date(now - 2 * 24 * 60 * 60 * 1000),
      })
      const rows = await getLeaderboard(u.id, {
        scope: 'friends',
        metric: 'showed-up',
        days: 7,
      })
      const me = rows.find((r) => r.userId === u.id)!
      // Today (both events coalesce) + 2-days-ago = 2 distinct days.
      expect(me.value).toBe(2)
    })
  })
})
