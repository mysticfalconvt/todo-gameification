import { createServerFn } from '@tanstack/react-start'
import { adminMiddleware } from '../middleware/admin'
import { authMiddleware } from '../middleware/auth'
import {
  countOpenInstances,
  isAdmin,
  listAllUsers,
  listRecentEvents,
  loadAdminSummary,
} from '../services/admin'
import { loadLlmMetrics } from '../services/llmTracking'

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
