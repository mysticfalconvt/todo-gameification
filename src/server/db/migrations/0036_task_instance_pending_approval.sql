-- Pending-approval state for chores completed by kids (and, in the
-- future, the kiosk user). Kid clicks "Complete" → instance gets
-- claimed_at + claimed_by_user_id but NOT completed_at. No event is
-- written and no XP is awarded until an adult approves the claim,
-- which promotes it to a normal completion. Rejecting clears the
-- claim and the instance is open again.
--
-- Admin/member completion is unaffected — they go straight to
-- completed_at (and XP) as before.

ALTER TABLE "task_instances"
  ADD COLUMN IF NOT EXISTS "claimed_at" timestamp,
  ADD COLUMN IF NOT EXISTS "claimed_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- Lookup: "what pending claims does this household have?" Cheapest
-- as a partial index since pending claims are a small subset of all
-- instances at any moment.
CREATE INDEX IF NOT EXISTS "task_instances_pending_claims_idx"
  ON "task_instances" ("household_id")
  WHERE "claimed_at" IS NOT NULL
    AND "completed_at" IS NULL
    AND "skipped_at" IS NULL;
