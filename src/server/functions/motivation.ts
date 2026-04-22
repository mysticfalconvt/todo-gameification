import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import * as service from '../services/motivation'

export const getMotivationStats = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { days?: number | 'all' } | undefined) => data ?? {},
  )
  .handler(({ data, context }) =>
    service.getMotivationStats(context.userId, data?.days ?? 30),
  )
