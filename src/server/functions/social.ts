import { createServerFn } from '@tanstack/react-start'
import { sql } from 'drizzle-orm'
import { authMiddleware } from '../middleware/auth'
import { db } from '../db/client'
import { user as userTable } from '../db/schema'
import { normalizeHandle } from '../services/handles'
import {
  acceptFriendRequest,
  blockUser,
  cancelFriendRequest,
  declineFriendRequest,
  listBlocked,
  listFriends,
  listIncomingRequests,
  listOutgoingRequests,
  removeFriend,
  sendFriendRequest,
  unblockUser,
} from '../services/social'

// Public — no auth — so the login form can swap a handle for an email
// before calling signIn.email. Handles are already discoverable via
// friend search (resolveUserByHandle), so this doesn't expose new
// info. Returns null when no match; sign-in surface should fail
// generically rather than echo "no such handle."
export const resolveHandleToEmailFn = createServerFn({ method: 'POST' })
  .inputValidator((data: { handle: string }) => data)
  .handler(async ({ data }) => {
    const handle = normalizeHandle(data.handle)
    if (!handle) return { email: null }
    const row = await db
      .select({ email: userTable.email })
      .from(userTable)
      .where(sql`lower(${userTable.handle}) = lower(${handle})`)
      .limit(1)
    return { email: row[0]?.email ?? null }
  })

export const listFriendsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => listFriends(context.userId))

export const listIncomingFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => listIncomingRequests(context.userId))

export const listOutgoingFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => listOutgoingRequests(context.userId))

export const listBlockedFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => listBlocked(context.userId))

export const sendFriendRequestFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { handle: string }) => {
    if (typeof data.handle !== 'string' || !data.handle.trim()) {
      throw new Error('Handle is required.')
    }
    return { handle: data.handle.trim() }
  })
  .handler(async ({ data, context }) =>
    sendFriendRequest(context.userId, data.handle),
  )

export const acceptFriendRequestFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { requesterId: string }) => {
    if (typeof data.requesterId !== 'string' || !data.requesterId) {
      throw new Error('Invalid request.')
    }
    return { requesterId: data.requesterId }
  })
  .handler(async ({ data, context }) => {
    await acceptFriendRequest(context.userId, data.requesterId)
    return { ok: true }
  })

export const declineFriendRequestFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { requesterId: string }) => {
    if (typeof data.requesterId !== 'string' || !data.requesterId) {
      throw new Error('Invalid request.')
    }
    return { requesterId: data.requesterId }
  })
  .handler(async ({ data, context }) => {
    await declineFriendRequest(context.userId, data.requesterId)
    return { ok: true }
  })

export const cancelFriendRequestFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { addresseeId: string }) => {
    if (typeof data.addresseeId !== 'string' || !data.addresseeId) {
      throw new Error('Invalid request.')
    }
    return { addresseeId: data.addresseeId }
  })
  .handler(async ({ data, context }) => {
    await cancelFriendRequest(context.userId, data.addresseeId)
    return { ok: true }
  })

export const removeFriendFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { otherUserId: string }) => {
    if (typeof data.otherUserId !== 'string' || !data.otherUserId) {
      throw new Error('Invalid request.')
    }
    return { otherUserId: data.otherUserId }
  })
  .handler(async ({ data, context }) => {
    await removeFriend(context.userId, data.otherUserId)
    return { ok: true }
  })

export const blockUserFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { targetUserId: string }) => {
    if (typeof data.targetUserId !== 'string' || !data.targetUserId) {
      throw new Error('Invalid request.')
    }
    return { targetUserId: data.targetUserId }
  })
  .handler(async ({ data, context }) => {
    await blockUser(context.userId, data.targetUserId)
    return { ok: true }
  })

export const unblockUserFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { targetUserId: string }) => {
    if (typeof data.targetUserId !== 'string' || !data.targetUserId) {
      throw new Error('Invalid request.')
    }
    return { targetUserId: data.targetUserId }
  })
  .handler(async ({ data, context }) => {
    await unblockUser(context.userId, data.targetUserId)
    return { ok: true }
  })
