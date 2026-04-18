import { createFileRoute } from '@tanstack/react-router'
import { and, desc, eq, gt } from 'drizzle-orm'
import { authedRoute, jsonOk } from '../../../server/api/rest'
import { db } from '../../../server/db/client'
import { events } from '../../../server/db/schema'

// GET /api/v1/events?since=<ISO>&limit=<1..200>
// Paginated feed of events for the authenticated user. Useful for LLM context
// or building custom dashboards. Descending by occurredAt.
export const Route = createFileRoute('/api/v1/events')({
  server: {
    handlers: {
      GET: authedRoute(async ({ request, userId }) => {
        const url = new URL(request.url)
        const rawSince = url.searchParams.get('since')
        const rawLimit = url.searchParams.get('limit')

        let since: Date | null = null
        if (rawSince) {
          const parsed = new Date(rawSince)
          if (Number.isNaN(parsed.getTime())) {
            throw new Error('invalid since parameter')
          }
          since = parsed
        }

        const limit = Math.min(
          Math.max(Number.parseInt(rawLimit ?? '50', 10) || 50, 1),
          200,
        )

        const rows = await db
          .select({
            id: events.id,
            type: events.type,
            payload: events.payload,
            occurredAt: events.occurredAt,
          })
          .from(events)
          .where(
            since
              ? and(eq(events.userId, userId), gt(events.occurredAt, since))
              : eq(events.userId, userId),
          )
          .orderBy(desc(events.occurredAt))
          .limit(limit)

        return jsonOk(
          rows.map((r) => ({
            id: r.id,
            type: r.type,
            payload: r.payload,
            occurredAt: r.occurredAt.toISOString(),
          })),
        )
      }),
    },
  },
})
