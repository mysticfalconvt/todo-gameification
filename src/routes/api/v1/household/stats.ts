import { createFileRoute } from '@tanstack/react-router'
import { authedRoute, jsonError, jsonOk } from '../../../../server/api/rest'
import {
  getMyMembership,
  listHouseholdStats,
} from '../../../../server/services/households'

// GET /api/v1/household/stats?days=30
// Per-member daily XP + completion counts in a rolling window, joined
// with member colors. Drives household dashboard charts.
export const Route = createFileRoute('/api/v1/household/stats')({
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
        const raw = url.searchParams.get('days')
        const days = raw ? Number.parseInt(raw, 10) : 30
        if (!Number.isFinite(days) || days < 1 || days > 365) {
          throw new Error('days must be an integer between 1 and 365')
        }
        const data = await listHouseholdStats(userId, m.householdId, days)
        return jsonOk(data)
      }),
    },
  },
})
