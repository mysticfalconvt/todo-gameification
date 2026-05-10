// Billing service. Wraps the Stripe SDK for checkout creation, portal
// sessions, pricing display, and webhook dispatch.
//
// The webhook handler is the only thing that grants entitlements. Each
// Stripe event:
//   1. Is dedup'd via the `stripe_webhook_events` table (Stripe replays
//      the same event id on retry).
//   2. Writes a domain `membership.*` event into the events table.
//   3. Folds that event onto the prior projection state via
//      `applyMembershipEvent` and upserts the row.
// All three steps run inside one DB transaction so a half-applied
// webhook can never leave the projection out of sync with the log.
import type Stripe from 'stripe'
import { eq } from 'drizzle-orm'
import type { DomainEvent } from '../../domain/events'
import {
  applyMembershipEvent,
  INITIAL_MEMBERSHIP,
  type MembershipState,
} from '../../domain/membership'
import { db } from '../db/client'
import { events, memberships, stripeWebhookEvents, user } from '../db/schema'
import {
  getAnnualPriceId,
  getLifetimePriceId,
  getStripe,
  getWebhookSecret,
} from '../stripe/client'
import {
  findUserIdByStripeCustomerId,
  loadProjectionState,
  upsertProjection,
} from './membership'

export interface CheckoutResult {
  url: string
}

export interface PricingDisplay {
  annual: { amount: number; currency: string; interval: string } | null
  lifetime: { amount: number; currency: string } | null
}

// Resolves an email to prefill on Stripe Checkout. Stripe uses this only
// when the user doesn't already have a stripe customer attached; once a
// customer exists, we pass `customer` instead of `customer_email`.
async function loadUserEmail(userId: string): Promise<string | null> {
  const row = await db.query.user.findFirst({
    where: eq(user.id, userId),
    columns: { email: true },
  })
  return row?.email ?? null
}

interface CheckoutInput {
  userId: string
  origin: string
}

async function createCheckout(
  input: CheckoutInput,
  kind: 'annual' | 'lifetime',
): Promise<CheckoutResult> {
  const stripe = getStripe()
  const projection = await loadProjectionState(input.userId)
  const email = await loadUserEmail(input.userId)

  const priceId = kind === 'annual' ? getAnnualPriceId() : getLifetimePriceId()
  const mode: 'subscription' | 'payment' =
    kind === 'annual' ? 'subscription' : 'payment'

  // Reuse an existing Stripe customer when we have one (annual upgrade
  // after a prior lifetime refund, or rebuying after a lapse) so the
  // user keeps a single billing history.
  const customerArgs: {
    customer?: string
    customer_email?: string
  } = projection.stripeCustomerId
    ? { customer: projection.stripeCustomerId }
    : email
      ? { customer_email: email }
      : {}

  const session = await stripe.checkout.sessions.create({
    mode,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: { userId: input.userId, kind },
    client_reference_id: input.userId,
    success_url: `${input.origin}/settings?billing=pending`,
    cancel_url: `${input.origin}/pricing`,
    automatic_tax: { enabled: true },
    ...customerArgs,
    ...(mode === 'subscription'
      ? { subscription_data: { metadata: { userId: input.userId } } }
      : { payment_intent_data: { metadata: { userId: input.userId } } }),
  })

  if (!session.url) {
    throw new Error('Stripe did not return a checkout url')
  }
  return { url: session.url }
}

export function createAnnualCheckout(input: CheckoutInput): Promise<CheckoutResult> {
  return createCheckout(input, 'annual')
}

export function createLifetimeCheckout(input: CheckoutInput): Promise<CheckoutResult> {
  return createCheckout(input, 'lifetime')
}

export async function createPortalSession(input: CheckoutInput): Promise<CheckoutResult> {
  const stripe = getStripe()
  const projection = await loadProjectionState(input.userId)
  if (!projection.stripeCustomerId) {
    throw new Error('No Stripe customer on file — manage your membership in the app.')
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: projection.stripeCustomerId,
    return_url: `${input.origin}/settings`,
  })
  return { url: session.url }
}

// Reads both prices from Stripe so the pricing UI never hardcodes
// dollars. Returns null for either side if the price isn't configured —
// the UI shows a "billing not configured" state instead of crashing.
export async function getPricingDisplay(): Promise<PricingDisplay> {
  const stripe = getStripe()
  const result: PricingDisplay = { annual: null, lifetime: null }

  const annualId = process.env.STRIPE_PRICE_ANNUAL
  if (annualId) {
    try {
      const price = await stripe.prices.retrieve(annualId)
      if (price.unit_amount != null) {
        result.annual = {
          amount: price.unit_amount,
          currency: price.currency,
          interval: price.recurring?.interval ?? 'year',
        }
      }
    } catch (err) {
      console.warn('[billing] failed to fetch annual price', err)
    }
  }

  const lifetimeId = process.env.STRIPE_PRICE_LIFETIME
  if (lifetimeId) {
    try {
      const price = await stripe.prices.retrieve(lifetimeId)
      if (price.unit_amount != null) {
        result.lifetime = {
          amount: price.unit_amount,
          currency: price.currency,
        }
      }
    } catch (err) {
      console.warn('[billing] failed to fetch lifetime price', err)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Webhook processing
// ---------------------------------------------------------------------------

export interface WebhookProcessResult {
  status: 'ok' | 'replay' | 'ignored'
  reason?: string
}

export async function processWebhookEvent(
  rawBody: string,
  signature: string | null,
): Promise<WebhookProcessResult> {
  if (!signature) {
    throw new Response('Missing stripe-signature header', { status: 400 })
  }
  const stripe = getStripe()
  const secret = getWebhookSecret()

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid signature'
    console.error('[billing] webhook signature verification failed', { msg })
    throw new Response(`Webhook signature verification failed: ${msg}`, {
      status: 400,
    })
  }

  console.log('[billing] webhook verified', { id: event.id, type: event.type })

  // Dedup: Stripe replays events on transient failures. Insert the id
  // first; an empty result means we already processed it.
  const dedup = await db
    .insert(stripeWebhookEvents)
    .values({ id: event.id, type: event.type })
    .onConflictDoNothing()
    .returning({ id: stripeWebhookEvents.id })
  if (dedup.length === 0) {
    console.log('[billing] webhook replay (already processed)', { id: event.id })
    return { status: 'replay' }
  }

  try {
    await dispatch(event)
  } catch (err) {
    console.error('[billing] dispatch threw', { id: event.id, type: event.type, err })
    throw err
  }
  console.log('[billing] webhook ok', { id: event.id, type: event.type })
  return { status: 'ok' }
}

async function dispatch(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(
        event,
        event.data.object as Stripe.Checkout.Session,
      )
    case 'invoice.paid':
      return handleInvoicePaid(event, event.data.object as Stripe.Invoice)
    case 'customer.subscription.updated':
      return handleSubscriptionUpdated(
        event,
        event.data.object as Stripe.Subscription,
      )
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(
        event,
        event.data.object as Stripe.Subscription,
      )
    case 'charge.refunded':
      return handleChargeRefunded(event, event.data.object as Stripe.Charge)
    default:
      // Many event types fire on a connected Stripe account that we don't
      // care about. Silently no-op so we still 200 and Stripe stops
      // retrying. Dedup row was already written above.
      console.log('[billing] webhook ignored (no handler)', {
        id: event.id,
        type: event.type,
      })
      return
  }
}

// In Stripe API version 2025-10-29 (clover) the per-cycle period_end
// moved from Subscription onto the items entries. For our single-item
// subscriptions this just means reading the first item.
function periodEndFromSubscription(
  sub: Stripe.Subscription,
): Date | null {
  const itemEnd = sub.items?.data?.[0]?.current_period_end
  if (typeof itemEnd === 'number') return new Date(itemEnd * 1000)
  return null
}

// Same migration moved Invoice.subscription onto Invoice.parent. Walks
// either shape to retrieve the subscription id.
function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription
  if (typeof sub === 'string') return sub
  if (sub && typeof sub === 'object' && 'id' in sub) {
    return (sub as { id: string }).id
  }
  return null
}

// Charge.invoice still arrives in webhook payloads but is no longer in
// the Stripe.Charge type as of v19. A non-null value means the charge is
// against an invoice (i.e. a subscription cycle), which we don't drop
// tier for.
function chargeBelongsToInvoice(charge: Stripe.Charge): boolean {
  const inv = (charge as unknown as { invoice?: string | { id: string } | null })
    .invoice
  return Boolean(inv)
}

async function resolveUserIdForEvent(
  event: Stripe.Event,
  hints: {
    metadataUserId?: string | null
    customerId?: string | null
  },
): Promise<string | null> {
  if (hints.metadataUserId) return hints.metadataUserId
  if (hints.customerId) {
    const id = await findUserIdByStripeCustomerId(hints.customerId)
    if (id) return id
  }
  console.warn(
    `[billing] webhook ${event.type} (${event.id}) had no userId attribution`,
  )
  return null
}

async function handleCheckoutCompleted(
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
): Promise<void> {
  const metadataUserId =
    typeof session.metadata?.userId === 'string'
      ? session.metadata.userId
      : (session.client_reference_id ?? null)
  const customerId =
    typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id ?? null

  console.log('[billing] checkout.session.completed received', {
    sessionId: session.id,
    mode: session.mode,
    customerId,
    metadataUserId,
    metadataKeys: session.metadata ? Object.keys(session.metadata) : [],
    clientReferenceId: session.client_reference_id,
  })

  const userId = await resolveUserIdForEvent(event, {
    metadataUserId,
    customerId,
  })
  if (!userId || !customerId) {
    console.warn('[billing] checkout.session.completed skipped — missing attribution', {
      sessionId: session.id,
      userId,
      customerId,
    })
    return
  }

  if (session.mode === 'subscription') {
    // Pull the subscription so we have current_period_end up front.
    const stripe = getStripe()
    const subscriptionId =
      typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id
    if (!subscriptionId) {
      console.warn('[billing] checkout subscription mode but no subscription id', {
        sessionId: session.id,
      })
      return
    }
    const subscription = await stripe.subscriptions.retrieve(subscriptionId)
    const periodEnd = periodEndFromSubscription(subscription)
    console.log('[billing] activating annual', {
      userId,
      customerId,
      subscriptionId,
      periodEnd: periodEnd?.toISOString() ?? null,
    })
    await applyAndPersist(userId, {
      type: 'membership.activated',
      tier: 'annual',
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      currentPeriodEnd: periodEnd,
      stripeEventId: event.id,
      occurredAt: new Date(event.created * 1000),
    })
    console.log('[billing] activated annual', { userId })
    return
  }

  if (session.mode === 'payment') {
    console.log('[billing] activating lifetime', { userId, customerId })
    await applyAndPersist(userId, {
      type: 'membership.activated',
      tier: 'lifetime',
      stripeCustomerId: customerId,
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
      stripeEventId: event.id,
      occurredAt: new Date(event.created * 1000),
    })
    console.log('[billing] activated lifetime', { userId })
    return
  }

  console.warn('[billing] unknown checkout session mode', {
    sessionId: session.id,
    mode: session.mode,
  })
}

async function handleInvoicePaid(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
): Promise<void> {
  // Only react to recurring-cycle invoices. The activation invoice is
  // already handled via checkout.session.completed.
  if (invoice.billing_reason !== 'subscription_cycle') return

  const customerId =
    typeof invoice.customer === 'string'
      ? invoice.customer
      : invoice.customer?.id ?? null
  const userId = await resolveUserIdForEvent(event, { customerId })
  if (!userId) return

  const subscriptionId = subscriptionIdFromInvoice(invoice)
  if (!subscriptionId) return

  const stripe = getStripe()
  const subscription = await stripe.subscriptions.retrieve(subscriptionId)
  const periodEnd = periodEndFromSubscription(subscription)
  if (!periodEnd) return

  await applyAndPersist(userId, {
    type: 'membership.renewed',
    currentPeriodEnd: periodEnd,
    stripeEventId: event.id,
    occurredAt: new Date(event.created * 1000),
  })
}

async function handleSubscriptionUpdated(
  event: Stripe.Event,
  subscription: Stripe.Subscription,
): Promise<void> {
  // We only care about the cancel_at_period_end transition here. Other
  // updates (price change, quantity change) don't affect entitlement.
  if (!subscription.cancel_at_period_end) return

  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer.id
  const userId = await resolveUserIdForEvent(event, { customerId })
  if (!userId) return

  const periodEnd = periodEndFromSubscription(subscription)
  if (!periodEnd) return
  await applyAndPersist(userId, {
    type: 'membership.cancel_scheduled',
    currentPeriodEnd: periodEnd,
    stripeEventId: event.id,
    occurredAt: new Date(event.created * 1000),
  })
}

async function handleSubscriptionDeleted(
  event: Stripe.Event,
  subscription: Stripe.Subscription,
): Promise<void> {
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer.id
  const userId = await resolveUserIdForEvent(event, { customerId })
  if (!userId) return

  const reason: 'period_end' | 'payment_failed' | 'voluntary' =
    subscription.status === 'canceled' && subscription.cancel_at_period_end
      ? 'period_end'
      : subscription.status === 'unpaid' || subscription.status === 'past_due'
        ? 'payment_failed'
        : 'voluntary'

  await applyAndPersist(userId, {
    type: 'membership.lapsed',
    reason,
    stripeEventId: event.id,
    occurredAt: new Date(event.created * 1000),
  })
}

async function handleChargeRefunded(
  event: Stripe.Event,
  charge: Stripe.Charge,
): Promise<void> {
  // Only treat lifetime payments as entitlement-affecting refunds. A
  // refunded subscription invoice should NOT drop tier — the cancellation
  // flow handles that via subscription.deleted.
  if (chargeBelongsToInvoice(charge)) return

  const customerId =
    typeof charge.customer === 'string'
      ? charge.customer
      : charge.customer?.id ?? null
  const userId = await resolveUserIdForEvent(event, { customerId })
  if (!userId) return

  await applyAndPersist(userId, {
    type: 'membership.refunded',
    stripeEventId: event.id,
    occurredAt: new Date(event.created * 1000),
  })
}

// Writes the domain event AND upserts the projection in one transaction.
// Used by every webhook handler. Idempotency comes from the
// stripe_webhook_events dedup wrapper one level up.
async function applyAndPersist(
  userId: string,
  domainEvent: DomainEvent,
): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await tx.query.memberships.findFirst({
      where: eq(memberships.userId, userId),
    })
    const prev: MembershipState = current
      ? {
          tier: current.tier,
          status: current.status,
          source: current.source,
          stripeCustomerId: current.stripeCustomerId,
          stripeSubscriptionId: current.stripeSubscriptionId,
          currentPeriodEnd: current.currentPeriodEnd,
          cancelAtPeriodEnd: current.cancelAtPeriodEnd,
          grantedBy: current.grantedBy,
          grantedAt: current.grantedAt,
        }
      : INITIAL_MEMBERSHIP

    const next = applyMembershipEvent(prev, domainEvent)

    await tx.insert(events).values({
      userId,
      type: domainEvent.type,
      payload: serializeEventPayload(domainEvent),
      occurredAt: domainEvent.occurredAt,
    })

    await upsertProjection(userId, next, tx as unknown as typeof db)
  })
}

function serializeEventPayload(e: DomainEvent): Record<string, unknown> {
  switch (e.type) {
    case 'membership.granted':
      return { tier: e.tier, grantedBy: e.grantedBy, reason: e.reason }
    case 'membership.activated':
      return {
        tier: e.tier,
        stripeCustomerId: e.stripeCustomerId,
        stripeSubscriptionId: e.stripeSubscriptionId,
        currentPeriodEnd: e.currentPeriodEnd?.toISOString() ?? null,
        stripeEventId: e.stripeEventId,
      }
    case 'membership.renewed':
      return {
        currentPeriodEnd: e.currentPeriodEnd.toISOString(),
        stripeEventId: e.stripeEventId,
      }
    case 'membership.cancel_scheduled':
      return {
        currentPeriodEnd: e.currentPeriodEnd.toISOString(),
        stripeEventId: e.stripeEventId,
      }
    case 'membership.lapsed':
      return { reason: e.reason, stripeEventId: e.stripeEventId }
    case 'membership.refunded':
      return { stripeEventId: e.stripeEventId }
    case 'membership.revoked':
      return { revokedBy: e.revokedBy, reason: e.reason }
    default:
      throw new Error(`unsupported membership event for serialize: ${e.type}`)
  }
}
