import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import {
  createAnnualCheckout,
  createLifetimeCheckout,
  createPortalSession,
  getPricingDisplay,
} from '../services/billing'
import { getEffectiveMemberStatus } from '../services/membership'
import { authMiddleware } from '../middleware/auth'

// Resolve the public origin for Stripe success/cancel URLs. Prefer the
// inbound request's URL (works in dev, prod, preview deploys, etc.);
// fall back to BETTER_AUTH_URL when invoked from a non-HTTP context.
function resolveOrigin(): string {
  try {
    const request = getRequest()
    return new URL(request.url).origin
  } catch {
    const fallback = process.env.BETTER_AUTH_URL
    if (!fallback) {
      throw new Error('Could not resolve origin for Stripe redirect URLs')
    }
    return fallback.replace(/\/+$/, '')
  }
}

export const createAnnualCheckoutFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(({ context }) =>
    createAnnualCheckout({ userId: context.userId, origin: resolveOrigin() }),
  )

export const createLifetimeCheckoutFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(({ context }) =>
    createLifetimeCheckout({ userId: context.userId, origin: resolveOrigin() }),
  )

export const createPortalSessionFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(({ context }) =>
    createPortalSession({ userId: context.userId, origin: resolveOrigin() }),
  )

// Public — no auth needed. Surfaced on the unauthenticated /pricing
// route and the landing page so visitors see real prices.
export const getPricingDisplayFn = createServerFn({ method: 'GET' }).handler(
  () => getPricingDisplay(),
)

// Used by /settings and the locked-feature overlays to know whether to
// render upgrade buttons or member content.
export const getMemberStatusFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => getEffectiveMemberStatus(context.userId))
