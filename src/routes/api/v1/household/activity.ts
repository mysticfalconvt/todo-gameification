import { createFileRoute } from '@tanstack/react-router'
import { authedRoute, jsonError, jsonOk } from '../../../../server/api/rest'
import {
  getMyMembership,
  listHouseholdActivity,
} from '../../../../server/services/households'

// GET /api/v1/household/activity?days=30&limit=50
// Merged feed of chore completions + member join/leave events for the
// viewer's household. Newest first.
export const Route = createFileRoute('/api/v1/household/activity')({
  server: {
    handlers: {
      GET: authedRoute(async ({ request, userId }) => {
        const m = await getMyMembership(userId)
        if (!m) {
          return jsonError(
            'not_found',
            'You are not in a household.',
            404,
          )
        }
        const url = new URL(request.url)
        const rawDays = url.searchParams.get('days')
        const rawLimit = url.searchParams.get('limit')
        const days = rawDays ? Number.parseInt(rawDays, 10) : 30
        const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 50
        if (!Number.isFinite(days) || days < 1 || days > 365) {
          throw new Error('days must be an integer between 1 and 365')
        }
        if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
          throw new Error('limit must be an integer between 1 and 200')
        }
        const data = await listHouseholdActivity(userId, m.householdId, {
          days,
          limit,
        })
        return jsonOk(data)
      }),
    },
  },
})
