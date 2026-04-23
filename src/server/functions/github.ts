import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import * as service from '../services/github'

export const getGithubIntegration = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => service.getGithubIntegration(context.userId))

export const upsertGithubIntegration = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { token: string; pollIntervalMinutes?: number }) => data,
  )
  .handler(({ data, context }) =>
    service.upsertGithubIntegration(context.userId, data),
  )

export const updateGithubPollInterval = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { pollIntervalMinutes: number }) => data)
  .handler(({ data, context }) =>
    service.updateGithubPollInterval(context.userId, data.pollIntervalMinutes),
  )

export const removeGithubIntegration = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(({ context }) => service.removeGithubIntegration(context.userId))

export const syncGithubNow = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(({ context }) => service.syncReviewTasksForUser(context.userId))
