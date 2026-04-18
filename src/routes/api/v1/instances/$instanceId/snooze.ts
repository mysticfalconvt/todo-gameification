import { createFileRoute } from '@tanstack/react-router'
import {
  authedRoute,
  jsonOk,
  readJson,
} from '../../../../../server/api/rest'
import * as service from '../../../../../server/services/tasks'

interface Body {
  hours?: number
}

export const Route = createFileRoute('/api/v1/instances/$instanceId/snooze')({
  server: {
    handlers: {
      POST: authedRoute(async ({ request, userId, params }) => {
        const body = await readJson<Body>(request)
        if (typeof body.hours !== 'number') {
          throw new Error('hours is required and must be a number')
        }
        const data = await service.snoozeInstance(
          userId,
          params.instanceId,
          body.hours,
        )
        return jsonOk(data)
      }),
    },
  },
})
