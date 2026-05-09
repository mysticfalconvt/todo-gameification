import { createFileRoute } from '@tanstack/react-router'
import { processWebhookEvent } from '../../server/services/billing'

// Stripe webhook receiver. The raw request body is fed to
// `stripe.webhooks.constructEvent` which verifies the signature, so any
// middleware that re-encodes the body would break verification — we
// pull from `request.text()` directly.
//
// Must NOT be cached by the service worker. `public/sw.js` excludes
// `/api/stripe-webhook` from `isAuthRequest()`.

export const Route = createFileRoute('/api/stripe-webhook')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const rawBody = await request.text()
        const signature = request.headers.get('stripe-signature')
        try {
          const result = await processWebhookEvent(rawBody, signature)
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        } catch (err) {
          if (err instanceof Response) return err
          const message = err instanceof Error ? err.message : 'webhook failed'
          console.error('[stripe-webhook]', err)
          return new Response(message, { status: 500 })
        }
      },
    },
  },
})
