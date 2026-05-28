import { createFileRoute } from '@tanstack/react-router'
import { authedRoute, jsonError, jsonOk } from '../../../../../server/api/rest'
import { getMyMembership } from '../../../../../server/services/households'
import { listHouseholdChores } from '../../../../../server/services/tasks'

// GET /api/v1/household/chores
// Open chores (not completed, not skipped) in the viewer's household.
// Each row carries assignee info (null = free-for-all), due time,
// difficulty, and a `recurring` flag.
export const Route = createFileRoute('/api/v1/household/chores/')({
  server: {
    handlers: {
      GET: authedRoute(async ({ userId }) => {
        const m = await getMyMembership(userId)
        if (!m) {
          return jsonError(
            'not_found',
            'You are not in a household.',
            404,
          )
        }
        const data = await listHouseholdChores(userId, m.householdId)
        return jsonOk(data)
      }),
    },
  },
})
