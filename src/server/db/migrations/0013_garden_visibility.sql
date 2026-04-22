-- Dedicated visibility axis for the community garden. Independent of
-- profile_visibility so users can share their garden publicly while
-- keeping the rest of their profile friends-only (or vice versa).
ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "garden_visibility" text NOT NULL DEFAULT 'friends';
--> statement-breakpoint
ALTER TABLE "user"
  DROP CONSTRAINT IF EXISTS "user_garden_visibility_chk";
--> statement-breakpoint
ALTER TABLE "user"
  ADD CONSTRAINT "user_garden_visibility_chk"
  CHECK ("garden_visibility" IN ('public','friends','private'));
