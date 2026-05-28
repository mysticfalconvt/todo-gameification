import { createFileRoute } from '@tanstack/react-router'
import { and, desc, eq, gt } from 'drizzle-orm'
import { authedRoute, jsonOk } from '../../../server/api/rest'
import { db } from '../../../server/db/client'
import { events } from '../../../server/db/schema'

// GET /api/v1/events?since=<ISO>&type=<eventType>&limit=<1..200>
// Paginated feed of events for the authenticated user. Useful for LLM context
// or building custom dashboards. Descending by occurredAt.
// `type` filters to a single event type (e.g. `task.completed`) — handy
// for keeping payloads small when you only care about completions.
export const Route = createFileRoute('/api/v1/events')({
  server: {
    handlers: {
      GET: authedRoute(async ({ request, userId }) => {
        const url = new URL(request.url)
        const rawSince = url.searchParams.get('since')
        const rawLimit = url.searchParams.get('limit')
        const rawType = url.searchParams.get('type')

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

        const conditions = [eq(events.userId, userId)]
        if (since) conditions.push(gt(events.occurredAt, since))
        if (rawType) conditions.push(eq(events.type, rawType))

        const rows = await db
          .select({
            id: events.id,
            type: events.type,
            payload: events.payload,
            occurredAt: events.occurredAt,
          })
          .from(events)
          .where(and(...conditions))
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
