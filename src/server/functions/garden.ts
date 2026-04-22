import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import { getGarden } from '../services/garden'
import {
  getCommunityGarden,
  type CommunityGardenScope,
} from '../services/communityGarden'

export const getGardenFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => getGarden(context.userId))

export const getCommunityGardenFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .inputValidator((data: { scope: CommunityGardenScope }) => {
    if (data.scope !== 'friends' && data.scope !== 'global') {
      throw new Error('invalid scope')
    }
    return data
  })
  .handler(({ data, context }) =>
    getCommunityGarden(context.userId, { scope: data.scope }),
  )
