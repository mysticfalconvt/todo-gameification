import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import * as service from '../services/featureRequests'

export const submitFeatureRequest = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: { title: string; description: string }) => data)
  .handler(({ data, context }) => service.submitFeatureRequest(context.userId, data))
