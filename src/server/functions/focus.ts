import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import * as service from '../services/focus'
import type { FocusMode } from '../../domain/events'

function coerceMode(input: unknown): FocusMode {
  return input === 'pocket' ? 'pocket' : 'visible'
}

export const startFocusSession = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: {
      durationMin: service.FocusDuration
      mode?: FocusMode
      taskInstanceId?: string | null
    }) => data,
  )
  .handler(({ data, context }) =>
    service.recordFocusStart({
      userId: context.userId,
      durationMin: data.durationMin,
      mode: coerceMode(data.mode),
      taskInstanceId: data.taskInstanceId ?? null,
    }),
  )

export const completeFocusSession = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: {
      durationMin: service.FocusDuration
      mode?: FocusMode
      startEventId?: string | null
      taskInstanceId?: string | null
    }) => data,
  )
  .handler(({ data, context }) =>
    service.completeFocusSession({
      userId: context.userId,
      durationMin: data.durationMin,
      mode: coerceMode(data.mode),
      startEventId: data.startEventId ?? null,
      taskInstanceId: data.taskInstanceId ?? null,
    }),
  )

export const cancelFocusSession = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { startEventId: string }) => data)
  .handler(({ data, context }) =>
    service.cancelFocusSession({
      userId: context.userId,
      startEventId: data.startEventId,
    }),
  )

export const getActiveFocusSession = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => service.getActiveFocusSession(context.userId))
