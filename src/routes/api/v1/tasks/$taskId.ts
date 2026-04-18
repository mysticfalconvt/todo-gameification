import { createFileRoute } from '@tanstack/react-router'
import {
  authedRoute,
  jsonOk,
  readJson,
} from '../../../../server/api/rest'
import * as service from '../../../../server/services/tasks'

interface PatchBody {
  title?: string
  notes?: string | null
  difficulty?: service.TaskDetail['difficulty']
  recurrence?: service.TaskDetail['recurrence']
  timeOfDay?: string | null
  snoozeUntil?: string | null
}

export const Route = createFileRoute('/api/v1/tasks/$taskId')({
  server: {
    handlers: {
      GET: authedRoute(async ({ userId, params }) => {
        const data = await service.getTask(userId, params.taskId)
        return jsonOk(data)
      }),
      PATCH: authedRoute(async ({ request, userId, params }) => {
        const body = await readJson<PatchBody>(request)
        const current = await service.getTask(userId, params.taskId)

        if ('snoozeUntil' in body) {
          await service.snoozeTask(
            userId,
            params.taskId,
            body.snoozeUntil ?? null,
          )
        }

        const needsUpdate =
          'title' in body ||
          'notes' in body ||
          'difficulty' in body ||
          'recurrence' in body ||
          'timeOfDay' in body
        if (needsUpdate) {
          await service.updateTask(userId, {
            taskId: params.taskId,
            title: body.title ?? current.title,
            notes: body.notes ?? current.notes,
            difficulty: body.difficulty ?? current.difficulty,
            recurrence:
              body.recurrence !== undefined ? body.recurrence : current.recurrence,
            timeOfDay:
              body.timeOfDay !== undefined ? body.timeOfDay : current.timeOfDay,
          })
        }

        const refreshed = await service.getTask(userId, params.taskId)
        return jsonOk(refreshed)
      }),
      DELETE: authedRoute(async ({ userId, params }) => {
        const data = await service.deleteTask(userId, params.taskId)
        return jsonOk(data)
      }),
    },
  },
})
