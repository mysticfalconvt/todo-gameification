import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import { getGarden } from '../services/garden'

export const getGardenFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => getGarden(context.userId))
