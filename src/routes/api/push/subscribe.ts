import { createFileRoute } from '@tanstack/react-router'
import { and, eq } from 'drizzle-orm'
import { auth } from '../../../server/auth'
import { db } from '../../../server/db/client'
import { pushSubscriptions } from '../../../server/db/schema'

interface IncomingSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
  deviceLabel?: string
}

export const Route = createFileRoute('/api/push/subscribe')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const session = await auth.api.getSession({ headers: request.headers })
        if (!session) {
          return new Response('Unauthorized', { status: 401 })
        }

        let body: IncomingSubscription
        try {
          body = (await request.json()) as IncomingSubscription
        } catch {
          return new Response('Invalid JSON', { status: 400 })
        }
        if (!body?.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
          return new Response('Missing endpoint or keys', { status: 400 })
        }

        // Check who (if anyone) already owns this endpoint. Endpoints are
        // unique, so without this guard an upsert would silently re-home
        // the subscription from the owning user to the caller — stealing
        // future notifications. If another user owns it, refuse; if the
        // caller already owns it, refresh keys + reset failure counters.
        const existing = await db.query.pushSubscriptions.findFirst({
          where: eq(pushSubscriptions.endpoint, body.endpoint),
          columns: { id: true, userId: true },
        })
        if (existing && existing.userId !== session.user.id) {
          return new Response('Endpoint registered to another account', {
            status: 409,
          })
        }
        if (existing) {
          await db
            .update(pushSubscriptions)
            .set({
              p256dh: body.keys.p256dh,
              auth: body.keys.auth,
              deviceLabel: body.deviceLabel ?? null,
              failureCount: 0,
              lastFailureAt: null,
            })
            .where(eq(pushSubscriptions.id, existing.id))
        } else {
          await db.insert(pushSubscriptions).values({
            userId: session.user.id,
            endpoint: body.endpoint,
            p256dh: body.keys.p256dh,
            auth: body.keys.auth,
            deviceLabel: body.deviceLabel ?? null,
          })
        }

        return Response.json({ ok: true })
      },
      DELETE: async ({ request }) => {
        const session = await auth.api.getSession({ headers: request.headers })
        if (!session) {
          return new Response('Unauthorized', { status: 401 })
        }
        let body: { endpoint?: string }
        try {
          body = (await request.json()) as { endpoint?: string }
        } catch {
          return new Response('Invalid JSON', { status: 400 })
        }
        if (!body.endpoint) {
          return new Response('Missing endpoint', { status: 400 })
        }
        // Only the row's owner can remove it. We don't distinguish "not
        // found" from "not yours" — the unsubscribe always reports ok so
        // we don't leak whether an endpoint is registered to someone
        // else.
        await db
          .delete(pushSubscriptions)
          .where(
            and(
              eq(pushSubscriptions.endpoint, body.endpoint),
              eq(pushSubscriptions.userId, session.user.id),
            ),
          )
        return Response.json({ ok: true })
      },
    },
  },
})
