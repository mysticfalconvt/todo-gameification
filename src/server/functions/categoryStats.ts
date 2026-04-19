import { eq } from 'drizzle-orm'
import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import { db } from '../db/client'
import { user as userTable } from '../db/schema'
import {
  getCategoryHistogramForUser,
  type CategoryScope,
} from '../services/categoryStats'
import { listFriends } from '../services/social'

const SCOPES: CategoryScope[] = ['active', 'completed']

export const getCategoryHistogramFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { targetUserId: string; scope: string }) => {
      if (
        typeof data.targetUserId !== 'string' ||
        !data.targetUserId
      ) {
        throw new Error('targetUserId is required.')
      }
      if (!SCOPES.includes(data.scope as CategoryScope)) {
        throw new Error('invalid scope')
      }
      return {
        targetUserId: data.targetUserId,
        scope: data.scope as CategoryScope,
      }
    },
  )
  .handler(async ({ data, context }) =>
    getCategoryHistogramForUser(
      context.userId,
      data.targetUserId,
      data.scope,
    ),
  )

// Bulk: viewer + all their friends, in one call. Skips anyone the viewer
// can't see or who opted out of activity sharing. Used by the Categories
// tab on /friends.
export const getFriendsCategoryHistogramsFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { scope: string }) => {
    if (!SCOPES.includes(data.scope as CategoryScope)) {
      throw new Error('invalid scope')
    }
    return { scope: data.scope as CategoryScope }
  })
  .handler(async ({ data, context }) => {
    const [friends, me] = await Promise.all([
      listFriends(context.userId),
      db.query.user.findFirst({
        where: eq(userTable.id, context.userId),
        columns: { name: true, handle: true },
      }),
    ])
    const entries = [
      {
        userId: context.userId,
        name: me?.name ?? 'You',
        handle: me?.handle ?? '',
        isMe: true,
      },
      ...friends.map((f) => ({
        userId: f.userId,
        name: f.name,
        handle: f.handle,
        isMe: false,
      })),
    ]
    const results = await Promise.all(
      entries.map(async (e) => {
        const hist = await getCategoryHistogramForUser(
          context.userId,
          e.userId,
          data.scope,
        )
        return { ...e, ...hist }
      }),
    )
    return results
  })
