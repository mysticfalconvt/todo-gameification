import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import { getPublicProfile } from '../services/profile'

export const getPublicProfileFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { handle: string }) => {
    if (typeof data.handle !== 'string' || !data.handle.trim()) {
      throw new Error('Handle is required.')
    }
    return { handle: data.handle.trim().replace(/^@/, '') }
  })
  .handler(async ({ data, context }) =>
    getPublicProfile(context.userId, data.handle),
  )
