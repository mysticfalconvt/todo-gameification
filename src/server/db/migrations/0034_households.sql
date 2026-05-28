-- Households: small shared groups built on top of the friends graph. A
-- household has members with roles (admin/member/kid) and can own tasks
-- that are either assigned to a specific member or "free-for-all" (any
-- member can claim and complete). XP for a household chore goes to the
-- completer; the event log's invariant `events.user_id = XP recipient`
-- continues to hold, with new payload fields capturing the household
-- context for activity feeds and aggregate queries.
--
-- One household per user is enforced at the DB layer via the unique
-- index on household_members.user_id, so service code can't drift.
-- Invites live in a dedicated table (not the friendships row) because
-- they carry a role and an inviter scope that would pollute the peer
-- friendship relation.

CREATE TABLE IF NOT EXISTS "households" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "created_by_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "created_at" timestamp NOT NULL DEFAULT NOW(),
  "updated_at" timestamp NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "household_members" (
  "household_id" uuid NOT NULL REFERENCES "households"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "role" text NOT NULL CHECK ("role" IN ('admin','member','kid')),
  "joined_at" timestamp NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("household_id","user_id")
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "household_members_user_uq"
  ON "household_members" ("user_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "household_members_household_role_idx"
  ON "household_members" ("household_id","role");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "household_invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "household_id" uuid NOT NULL REFERENCES "households"("id") ON DELETE CASCADE,
  "inviter_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "invitee_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "proposed_role" text NOT NULL CHECK ("proposed_role" IN ('member','kid')),
  "status" text NOT NULL DEFAULT 'pending'
    CHECK ("status" IN ('pending','accepted','declined','cancelled')),
  "created_at" timestamp NOT NULL DEFAULT NOW(),
  "responded_at" timestamp
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "household_invites_unique_pending_idx"
  ON "household_invites" ("household_id","invitee_user_id")
  WHERE "status" = 'pending';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "household_invites_invitee_status_idx"
  ON "household_invites" ("invitee_user_id","status");
--> statement-breakpoint

ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "household_id" uuid REFERENCES "households"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "assigned_to_user_id" text REFERENCES "user"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tasks_household_idx"
  ON "tasks" ("household_id") WHERE "household_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "task_instances"
  ADD COLUMN IF NOT EXISTS "household_id" uuid REFERENCES "households"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "assigned_to_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "completed_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "task_instances_household_open_idx"
  ON "task_instances" ("household_id","due_at")
  WHERE "completed_at" IS NULL AND "skipped_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "task_instances_household_assignee_idx"
  ON "task_instances" ("household_id","assigned_to_user_id");
--> statement-breakpoint

ALTER TABLE "user_prefs"
  ADD COLUMN IF NOT EXISTS "merge_household_into_today" boolean NOT NULL DEFAULT true;
--> statement-breakpoint

-- Partial expression index for per-household aggregate queries on the
-- event log (e.g. household leaderboard window, "completions this week
-- in this household"). Per-member stats reuse the existing user-scoped
-- events index and don't need this.
CREATE INDEX IF NOT EXISTS "events_household_completed_idx"
  ON "events" ((payload->>'householdId'))
  WHERE type = 'task.completed' AND payload->>'householdId' IS NOT NULL;
