import { createFileRoute } from '@tanstack/react-router'
import { authedRoute, jsonOk } from '../../../../../server/api/rest'
import * as service from '../../../../../server/services/tasks'

export const Route = createFileRoute('/api/v1/instances/$instanceId/skip')({
  server: {
    handlers: {
      POST: authedRoute(async ({ userId, params }) => {
        const data = await service.skipInstance(userId, params.instanceId)
        return jsonOk(data)
      }),
    },
  },
})
