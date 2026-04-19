-- Per-user quiet-hours window for suppressing reminder escalations.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "quiet_hours_start" text;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "quiet_hours_end" text;
