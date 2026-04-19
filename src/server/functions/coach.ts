import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import * as service from '../services/coach'

export const getCoachSummary = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => service.generateCoachSummary(context.userId))
