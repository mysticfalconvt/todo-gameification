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
        console.log('[stripe-webhook] received', {
          bytes: rawBody.length,
          hasSignature: Boolean(signature),
        })
        try {
          const result = await processWebhookEvent(rawBody, signature)
          console.log('[stripe-webhook] processed', result)
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        } catch (err) {
          if (err instanceof Response) {
            console.warn('[stripe-webhook] rejected', {
              status: err.status,
              statusText: err.statusText,
            })
            return err
          }
          const message = err instanceof Error ? err.message : 'webhook failed'
          console.error('[stripe-webhook] handler threw', err)
          return new Response(message, { status: 500 })
        }
      },
    },
  },
})
