import { describe, expect, it } from 'vitest'
import { withTestUsers } from '../../test/helpers'
import {
  acceptFriendRequest,
  blockUser,
  canView,
  declineFriendRequest,
  listFriends,
  listIncomingRequests,
  removeFriend,
  sendFriendRequest,
} from './social'

// Contract tests for src/server/services/social.ts — friendship
// transitions and the canView privacy gate. Each test gets fresh users
// so state never bleeds between runs.

describe('social service', () => {
  it('sendFriendRequest creates a pending row', async () => {
    await withTestUsers(2, async ([a, b]) => {
      const res = await sendFriendRequest(a.id, b.handle)
      expect(res.status).toBe('sent')
      expect(res.otherUserId).toBe(b.id)
      const incoming = await listIncomingRequests(b.id)
      expect(incoming.map((r) => r.userId)).toContain(a.id)
    })
  })

  it('sendFriendRequest to yourself throws', async () => {
    await withTestUsers(1, async ([a]) => {
      await expect(sendFriendRequest(a.id, a.handle)).rejects.toThrow(
        /can't friend yourself/i,
      )
    })
  })

  it('sendFriendRequest to unknown handle throws', async () => {
    await withTestUsers(1, async ([a]) => {
      await expect(sendFriendRequest(a.id, 'no_such_handle_999')).rejects.toThrow(
        /no user/i,
      )
    })
  })

  it('reverse sendFriendRequest auto-accepts existing pending', async () => {
    await withTestUsers(2, async ([a, b]) => {
      await sendFriendRequest(a.id, b.handle)
      const res = await sendFriendRequest(b.id, a.handle)
      expect(res.status).toBe('accepted')
      const aFriends = await listFriends(a.id)
      expect(aFriends.map((f) => f.userId)).toContain(b.id)
    })
  })

  it('acceptFriendRequest promotes pending → accepted', async () => {
    await withTestUsers(2, async ([a, b]) => {
      await sendFriendRequest(a.id, b.handle)
      await acceptFriendRequest(b.id, a.id)
      const bFriends = await listFriends(b.id)
      expect(bFriends.map((f) => f.userId)).toContain(a.id)
    })
  })

  it('acceptFriendRequest throws when there is no pending row', async () => {
    await withTestUsers(2, async ([a, b]) => {
      await expect(acceptFriendRequest(b.id, a.id)).rejects.toThrow(
        /no pending request/i,
      )
    })
  })

  it('declineFriendRequest removes the pending row', async () => {
    await withTestUsers(2, async ([a, b]) => {
      await sendFriendRequest(a.id, b.handle)
      await declineFriendRequest(b.id, a.id)
      const incoming = await listIncomingRequests(b.id)
      expect(incoming.find((r) => r.userId === a.id)).toBeUndefined()
    })
  })

  it('removeFriend wipes an accepted friendship', async () => {
    await withTestUsers(2, async ([a, b]) => {
      await sendFriendRequest(a.id, b.handle)
      await acceptFriendRequest(b.id, a.id)
      await removeFriend(a.id, b.id)
      expect(await listFriends(a.id)).toHaveLength(0)
      expect(await listFriends(b.id)).toHaveLength(0)
    })
  })

  describe('canView', () => {
    it('self is always viewable', async () => {
      await withTestUsers(1, async ([a]) => {
        expect(await canView(a.id, a.id)).toBe(true)
      })
    })

    it('private profiles are hidden from non-self', async () => {
      await withTestUsers(2, async ([a, b]) => {
        await import('../db/client').then(async ({ db }) => {
          const { user } = await import('../db/schema')
          const { eq } = await import('drizzle-orm')
          await db
            .update(user)
            .set({ profileVisibility: 'private' })
            .where(eq(user.id, b.id))
        })
        expect(await canView(a.id, b.id)).toBe(false)
      })
    })

    it('public profiles are viewable by anyone', async () => {
      await withTestUsers(2, async ([a, b]) => {
        await import('../db/client').then(async ({ db }) => {
          const { user } = await import('../db/schema')
          const { eq } = await import('drizzle-orm')
          await db
            .update(user)
            .set({ profileVisibility: 'public' })
            .where(eq(user.id, b.id))
        })
        expect(await canView(a.id, b.id)).toBe(true)
      })
    })

    it('friends-only profiles require an accepted friendship', async () => {
      await withTestUsers(2, async ([a, b]) => {
        // Default visibility is 'friends' — both users start at that.
        expect(await canView(a.id, b.id)).toBe(false)
        await sendFriendRequest(a.id, b.handle)
        await acceptFriendRequest(b.id, a.id)
        expect(await canView(a.id, b.id)).toBe(true)
        expect(await canView(b.id, a.id)).toBe(true)
      })
    })

    it('blocks hide the blocker from the blocked user', async () => {
      await withTestUsers(2, async ([a, b]) => {
        await import('../db/client').then(async ({ db }) => {
          const { user } = await import('../db/schema')
          const { eq } = await import('drizzle-orm')
          await db
            .update(user)
            .set({ profileVisibility: 'public' })
            .where(eq(user.id, a.id))
        })
        // Even though a is public, a blocking b means b can't see a.
        await blockUser(a.id, b.id)
        expect(await canView(b.id, a.id)).toBe(false)
      })
    })
  })
})
