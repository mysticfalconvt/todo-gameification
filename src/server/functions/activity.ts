import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import { cheerCompletion, getFriendActivity } from '../services/activity'

export const getFriendActivityFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { days?: number; limit?: number }) => {
    const days =
      typeof data.days === 'number' && data.days > 0 && data.days <= 90
        ? data.days
        : 7
    const limit =
      typeof data.limit === 'number' && data.limit > 0 && data.limit <= 200
        ? data.limit
        : 50
    return { days, limit }
  })
  .handler(async ({ data, context }) =>
    getFriendActivity(context.userId, data),
  )

export const cheerCompletionFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { completionEventId: string }) => {
    if (
      typeof data.completionEventId !== 'string' ||
      !data.completionEventId
    ) {
      throw new Error('Invalid event id.')
    }
    return { completionEventId: data.completionEventId }
  })
  .handler(async ({ data, context }) =>
    cheerCompletion(context.userId, data.completionEventId),
  )
