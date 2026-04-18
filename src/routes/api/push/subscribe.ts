import { createFileRoute } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'
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

        await db
          .insert(pushSubscriptions)
          .values({
            userId: session.user.id,
            endpoint: body.endpoint,
            p256dh: body.keys.p256dh,
            auth: body.keys.auth,
            deviceLabel: body.deviceLabel ?? null,
          })
          .onConflictDoUpdate({
            target: pushSubscriptions.endpoint,
            set: {
              userId: session.user.id,
              p256dh: body.keys.p256dh,
              auth: body.keys.auth,
              deviceLabel: body.deviceLabel ?? null,
              failureCount: 0,
              lastFailureAt: null,
            },
          })

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
        await db
          .delete(pushSubscriptions)
          .where(eq(pushSubscriptions.endpoint, body.endpoint))
        return Response.json({ ok: true })
      },
    },
  },
})
