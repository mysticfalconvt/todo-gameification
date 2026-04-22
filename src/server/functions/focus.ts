import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import * as service from '../services/focus'

export const startFocusSession = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: {
      durationMin: service.FocusDuration
      taskInstanceId?: string | null
    }) => data,
  )
  .handler(({ data, context }) =>
    service.recordFocusStart({
      userId: context.userId,
      durationMin: data.durationMin,
      taskInstanceId: data.taskInstanceId ?? null,
    }),
  )

export const completeFocusSession = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: {
      durationMin: service.FocusDuration
      taskInstanceId?: string | null
    }) => data,
  )
  .handler(({ data, context }) =>
    service.completeFocusSession({
      userId: context.userId,
      durationMin: data.durationMin,
      taskInstanceId: data.taskInstanceId ?? null,
    }),
  )
