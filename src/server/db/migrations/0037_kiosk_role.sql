-- Adds 'kiosk' to the household_members.role CHECK enum so admins
-- can create shared kiosk accounts (e.g. an iPad on the kitchen
-- counter that the whole family uses to mark chores done).
--
-- Kiosk behaves like 'kid' for completion (chores claim into the
-- pending-approval queue), but is created directly by an admin —
-- there's no friend-invite path. The household_invites.proposed_role
-- CHECK constraint is left as ('member','kid') intentionally;
-- kiosks aren't invited, they're provisioned by admins through the
-- Members tab.

ALTER TABLE "household_members"
  DROP CONSTRAINT IF EXISTS "household_members_role_check";
--> statement-breakpoint

ALTER TABLE "household_members"
  ADD CONSTRAINT "household_members_role_check"
  CHECK ("role" IN ('admin','member','kid','kiosk'));
