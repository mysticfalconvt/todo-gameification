import { createFileRoute } from '@tanstack/react-router'
import { authedRoute, jsonOk } from '../../../server/api/rest'
import * as service from '../../../server/services/tasks'

export const Route = createFileRoute('/api/v1/progression')({
  server: {
    handlers: {
      GET: authedRoute(async ({ userId }) => {
        const data = await service.getProgression(userId)
        return jsonOk(data)
      }),
    },
  },
})
