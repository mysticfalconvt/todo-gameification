-- Allow 'trial' as a membership tier. The 0029 migration created the
-- memberships table with `tier text` and no DB-level CHECK constraint —
-- this migration adds a defensive CHECK and pre-emptively drops any
-- prior constraint by the same name so re-runs are safe.

ALTER TABLE "memberships" DROP CONSTRAINT IF EXISTS "memberships_tier_check";
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tier_check"
  CHECK ("tier" IN ('free', 'trial', 'annual', 'lifetime'));
