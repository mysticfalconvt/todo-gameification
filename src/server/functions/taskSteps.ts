// Thin wrappers for the subtask checklist server functions. Logic
// lives in src/server/services/tasks.ts; this file is just the
// cookie-auth boundary.
import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../middleware/auth'
import * as service from '../services/tasks'

export const listTaskSteps = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { taskId: string; instanceId?: string | null }) => data,
  )
  .handler(({ data, context }) =>
    service.listTaskSteps(
      context.userId,
      data.taskId,
      data.instanceId ?? null,
    ),
  )

export const addTaskStep = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { taskId: string; title: string }) => data)
  .handler(({ data, context }) =>
    service.addTaskStep(context.userId, data.taskId, data.title),
  )

export const renameTaskStep = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { stepId: string; title: string }) => data)
  .handler(({ data, context }) =>
    service.renameTaskStep(context.userId, data.stepId, data.title),
  )

export const reorderTaskSteps = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { taskId: string; orderedIds: string[] }) => data)
  .handler(({ data, context }) =>
    service.reorderTaskSteps(context.userId, data.taskId, data.orderedIds),
  )

export const deleteTaskStep = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { stepId: string }) => data)
  .handler(({ data, context }) =>
    service.deleteTaskStep(context.userId, data.stepId),
  )

export const toggleTaskStep = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { stepId: string; instanceId: string }) => data,
  )
  .handler(({ data, context }) =>
    service.toggleTaskStep(context.userId, data.stepId, data.instanceId),
  )
