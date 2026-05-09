// Stripe SDK singleton. The constructor pins an apiVersion so a future
// Stripe library bump can't silently shift webhook payload shapes.
//
// All env reads are lazy so a misconfigured env doesn't crash the
// whole server on boot — only billing routes will throw.
import Stripe from 'stripe'

let instance: Stripe | undefined

export function getStripe(): Stripe {
  if (instance) return instance
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Add it to your environment to enable billing.',
    )
  }
  // Pin to the SDK's bundled apiVersion so webhook payload shapes match
  // the TypeScript types in the installed Stripe package.
  instance = new Stripe(key, { apiVersion: '2025-10-29.clover' })
  return instance
}

export function getWebhookSecret(): string {
  const v = process.env.STRIPE_WEBHOOK_SECRET
  if (!v) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not set.')
  }
  return v
}

export function getAnnualPriceId(): string {
  const v = process.env.STRIPE_PRICE_ANNUAL
  if (!v) throw new Error('STRIPE_PRICE_ANNUAL is not set.')
  return v
}

export function getLifetimePriceId(): string {
  const v = process.env.STRIPE_PRICE_LIFETIME
  if (!v) throw new Error('STRIPE_PRICE_LIFETIME is not set.')
  return v
}

// Truthy when all four billing env vars are present; the pricing UI uses
// this to decide whether to render checkout buttons or fall back to a
// "billing not configured" hint.
export function isBillingConfigured(): boolean {
  return Boolean(
    process.env.STRIPE_SECRET_KEY &&
      process.env.STRIPE_WEBHOOK_SECRET &&
      process.env.STRIPE_PRICE_ANNUAL &&
      process.env.STRIPE_PRICE_LIFETIME,
  )
}
