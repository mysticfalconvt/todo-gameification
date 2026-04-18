import { createFileRoute } from '@tanstack/react-router'
import { authedRoute, jsonOk } from '../../../server/api/rest'
import * as service from '../../../server/services/tasks'

export const Route = createFileRoute('/api/v1/today')({
  server: {
    handlers: {
      GET: authedRoute(async ({ userId }) => {
        const data = await service.listTodayInstances(userId)
        return jsonOk(data)
      }),
    },
  },
})
