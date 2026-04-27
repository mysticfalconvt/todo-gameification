// Thin wrappers for the browser-facing Start server functions. All logic
// lives in src/server/services/tasks.ts — this file is just the cookie-auth
// boundary. REST routes under /api/v1 delegate to the same services with
// token auth instead of cookies.
import { createServerFn } from '@tanstack/react-start'
import type { Recurrence } from '../../domain/recurrence'
import type { Difficulty } from '../../domain/events'
import { authMiddleware } from '../middleware/auth'
import * as service from '../services/tasks'

export const createTask = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: service.CreateTaskInput) => data)
  .handler(({ data, context }) => service.createTask(context.userId, data))

export const listTodayInstances = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => service.listTodayInstances(context.userId))

export const listSomedayInstances = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => service.listSomedayInstances(context.userId))

export const completeInstance = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { instanceId: string; force?: boolean }) => data,
  )
  .handler(({ data, context }) =>
    service.completeInstance(context.userId, data.instanceId, {
      force: data.force,
    }),
  )

export const skipInstance = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { instanceId: string }) => data)
  .handler(({ data, context }) =>
    service.skipInstance(context.userId, data.instanceId),
  )

export const snoozeInstance = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { instanceId: string; hours: number }) => data)
  .handler(({ data, context }) =>
    service.snoozeInstance(context.userId, data.instanceId, data.hours),
  )

export const deferInstanceToTomorrow = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { instanceId: string }) => data)
  .handler(({ data, context }) =>
    service.deferInstanceToTomorrow(context.userId, data.instanceId),
  )

export const listAllTasks = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => service.listAllTasks(context.userId))

export const getTask = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .inputValidator((data: { taskId: string }) => data)
  .handler(({ data, context }) => service.getTask(context.userId, data.taskId))

export const updateTask = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: {
      taskId: string
      title: string
      notes: string | null
      difficulty: Difficulty
      recurrence: Recurrence | null
      timeOfDay: string | null
      visibility?: service.TaskVisibility
    }) => data,
  )
  .handler(({ data, context }) => service.updateTask(context.userId, data))

export const deleteTask = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { taskId: string }) => data)
  .handler(({ data, context }) =>
    service.deleteTask(context.userId, data.taskId),
  )

export const setTaskCategory = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { taskId: string; slug: string | null }) => data)
  .handler(({ data, context }) =>
    service.setTaskCategory(context.userId, data.taskId, data.slug),
  )

export const reopenLastCompletion = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { taskId: string }) => data)
  .handler(({ data, context }) =>
    service.reopenLastCompletion(context.userId, data.taskId),
  )

export const snoozeTask = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { taskId: string; until: string | null }) => data)
  .handler(({ data, context }) =>
    service.snoozeTask(context.userId, data.taskId, data.until),
  )

export const reanalyzeTask = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator((data: { taskId: string }) => data)
  .handler(({ data, context }) =>
    service.reanalyzeTask(context.userId, data.taskId),
  )

export const getProgression = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => service.getProgression(context.userId))

export const listRecentActivity = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => service.listRecentActivity(context.userId))

export const categoryCounts = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .inputValidator((data: { scope: 'active' | 'completed' }) => data)
  .handler(({ data, context }) =>
    service.categoryCounts(context.userId, data.scope),
  )

export const getStats = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { days?: number | 'all' } | undefined) => data ?? {},
  )
  .handler(({ data, context }) =>
    service.getStats(context.userId, data?.days ?? 30),
  )

export const getTaskStats = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .inputValidator(
    (data: { taskId: string; days?: number | 'all' }) => data,
  )
  .handler(({ data, context }) =>
    service.getTaskStats(context.userId, data.taskId, data.days ?? 30),
  )

export const listCompletionHistory = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .inputValidator((data: { days?: number } | undefined) => data ?? {})
  .handler(({ data, context }) =>
    service.listCompletionHistory(context.userId, data?.days ?? 30),
  )
