import { createFileRoute } from '@tanstack/react-router'
import {
  authedRoute,
  jsonOk,
  readJson,
} from '../../../../server/api/rest'
import * as service from '../../../../server/services/tasks'

export const Route = createFileRoute('/api/v1/tasks/')({
  server: {
    handlers: {
      GET: authedRoute(async ({ userId }) => {
        const data = await service.listAllTasks(userId)
        return jsonOk(data)
      }),
      POST: authedRoute(async ({ request, userId }) => {
        const body = await readJson<service.CreateTaskInput>(request)
        const data = await service.createTask(userId, body)
        return jsonOk(data, 201)
      }),
    },
  },
})
