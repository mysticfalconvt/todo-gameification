import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import * as service from '../services/doomscroll'

export const startDoomScroll = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { durationMin: service.DoomScrollDuration }) => data)
  .handler(({ data, context }) =>
    service.recordDoomScrollStart({
      userId: context.userId,
      durationMin: data.durationMin,
    }),
  )
