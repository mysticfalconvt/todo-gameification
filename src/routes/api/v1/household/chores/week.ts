import { createFileRoute } from '@tanstack/react-router'
import { formatInTimeZone } from 'date-fns-tz'
import { authedRoute, jsonError, jsonOk } from '../../../../../server/api/rest'
import { getMyMembership } from '../../../../../server/services/households'
import {
  getUserTimeZone,
  listHouseholdChoresWeek,
} from '../../../../../server/services/tasks'

// Returns the yyyy-MM-dd of the most recent Sunday in the user's
// timezone — same anchor the in-app Week view uses, so a client that
// omits ?startDate gets "this week" by default.
function currentWeekStartLocal(timeZone: string): string {
  const now = new Date()
  // Compute today's local weekday in the user's tz. en-US 'short'
  // weekday is stable: Sun, Mon, ... so we can map cheaply.
  const weekdayShort = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(now)
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }
  const dow = map[weekdayShort] ?? 0
  // Roll back `dow` days from today's local instant. Using ms math is
  // safe across DST because we re-format afterwards in the target tz.
  const sundayInstant = new Date(now.getTime() - dow * 24 * 3_600_000)
  return formatInTimeZone(sundayInstant, timeZone, 'yyyy-MM-dd')
}

// GET /api/v1/household/chores/week?startDate=yyyy-MM-dd
// 7-day chore grid for the household, including projected future
// occurrences for recurring tasks (`instanceId: null`). Defaults to
// the Sunday-anchored week containing today in the viewer's tz.
export const Route = createFileRoute('/api/v1/household/chores/week')({
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
        let startDate = url.searchParams.get('startDate')
        if (startDate) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
            throw new Error('startDate must be yyyy-MM-dd')
          }
        } else {
          const timeZone = await getUserTimeZone(userId)
          startDate = currentWeekStartLocal(timeZone)
        }
        const data = await listHouseholdChoresWeek(
          userId,
          m.householdId,
          startDate,
        )
        return jsonOk({ startDate, occurrences: data })
      }),
    },
  },
})
