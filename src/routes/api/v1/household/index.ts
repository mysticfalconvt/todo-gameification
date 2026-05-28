import { createFileRoute } from '@tanstack/react-router'
import { authedRoute, jsonError, jsonOk } from '../../../../server/api/rest'
import { getMyHousehold } from '../../../../server/services/households'

// GET /api/v1/household
// Viewer's household + member roster (id, name, role, color). Returns
// 404 if the viewer isn't in a household.
export const Route = createFileRoute('/api/v1/household/')({
  server: {
    handlers: {
      GET: authedRoute(async ({ userId }) => {
        const data = await getMyHousehold(userId)
        if (!data) {
          return jsonError(
            'not_found',
            'You are not in a household.',
            404,
          )
        }
        return jsonOk(data)
      }),
    },
  },
})
