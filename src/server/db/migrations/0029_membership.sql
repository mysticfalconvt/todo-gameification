-- Membership projection + Stripe webhook idempotency.
--
-- The `memberships` table is a folded view of the membership.* events in
-- the events table. Webhooks (and admin grant/revoke) write the event and
-- upsert this row in one transaction. Reads across the app are O(1) via
-- the userId PK, and the partial unique index on stripeCustomerId lets
-- the webhook attribute Stripe events back to a user.
--
-- The `stripe_webhook_events` table is the dedup boundary: webhook events
-- are inserted by Stripe event id with ON CONFLICT DO NOTHING, so a Stripe
-- replay short-circuits before we do any work.

CREATE TABLE IF NOT EXISTS "memberships" (
  "user_id" text PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "tier" text NOT NULL DEFAULT 'free',
  "status" text NOT NULL DEFAULT 'none',
  "source" text NOT NULL DEFAULT 'none',
  "stripe_customer_id" text,
  "stripe_subscription_id" text,
  "current_period_end" timestamp,
  "cancel_at_period_end" boolean NOT NULL DEFAULT false,
  "granted_by" text,
  "granted_at" timestamp,
  "updated_at" timestamp NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "memberships_stripe_customer_uq"
  ON "memberships" ("stripe_customer_id")
  WHERE "stripe_customer_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
  "id" text PRIMARY KEY,
  "type" text NOT NULL,
  "processed_at" timestamp NOT NULL DEFAULT NOW()
);
