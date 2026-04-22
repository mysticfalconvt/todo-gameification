import { createServerFn } from '@tanstack/react-start'
import { adminMiddleware } from '../middleware/admin'
import { authMiddleware } from '../middleware/auth'
import {
  countOpenInstances,
  getLlmCallDetail,
  grantTokens,
  isAdmin,
  listAllUsers,
  listLlmCalls,
  listRecentEvents,
  loadAdminSummary,
  loadLlmUsage,
  loadUserDetail,
} from '../services/admin'
import { loadLlmMetrics } from '../services/llmTracking'
import { loadJobStats } from '../services/jobs'

// Cheap non-admin check used by the nav + route beforeLoad so the link is
// only rendered for admins. Returns a plain boolean so no 403 handling is
// needed on the client for the common (non-admin) case.
export const getIsAdminFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => ({ isAdmin: await isAdmin(context.userId) }))

export const getAdminSummaryFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async () => loadAdminSummary())

export const listAdminUsersFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async () => listAllUsers())

export const listAdminEventsFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator((data: { limit?: number }) => ({
    limit: typeof data.limit === 'number' ? data.limit : 50,
  }))
  .handler(async ({ data }) => listRecentEvents(data.limit))

export const getAdminOpenInstancesFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async () => countOpenInstances())

export const getAdminLlmMetricsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async () => loadLlmMetrics())

export const getAdminJobStatsFn = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async () => loadJobStats())

// Drill-in for a single user. userId is the better-auth text id.
export const getAdminUserDetailFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator((data: { userId: string }) => {
    if (typeof data?.userId !== 'string' || !data.userId) {
      throw new Error('userId required')
    }
    return { userId: data.userId }
  })
  .handler(async ({ data }) => loadUserDetail(data.userId))

export const getAdminLlmUsageFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator((data: { windowDays?: number }) => ({
    windowDays:
      typeof data?.windowDays === 'number' && data.windowDays > 0
        ? Math.min(90, Math.floor(data.windowDays))
        : 14,
  }))
  .handler(async ({ data }) => loadLlmUsage(data.windowDays))

export const listAdminLlmCallsFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(
    (data: {
      kind?: string
      userId?: string
      before?: string | null
      limit?: number
    }) => ({
      kind: data?.kind?.trim() || undefined,
      userId: data?.userId?.trim() || undefined,
      before: data?.before ?? null,
      limit: typeof data?.limit === 'number' ? data.limit : 50,
    }),
  )
  .handler(async ({ data }) => listLlmCalls(data))

export const getAdminLlmCallFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator((data: { id: string }) => {
    if (typeof data?.id !== 'string' || !data.id) {
      throw new Error('id required')
    }
    return { id: data.id }
  })
  .handler(async ({ data }) => getLlmCallDetail(data.id))

export const grantTokensFn = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(
    (data: { userId: string; amount: number; reason?: string | null }) => {
      if (typeof data?.userId !== 'string' || !data.userId) {
        throw new Error('userId required')
      }
      if (typeof data?.amount !== 'number' || !Number.isInteger(data.amount)) {
        throw new Error('amount must be an integer')
      }
      return {
        userId: data.userId,
        amount: data.amount,
        reason:
          typeof data.reason === 'string' && data.reason.trim()
            ? data.reason.trim()
            : null,
      }
    },
  )
  .handler(({ data, context }) =>
    grantTokens({
      targetUserId: data.userId,
      grantedBy: context.userId,
      amount: data.amount,
      reason: data.reason,
    }),
  )
