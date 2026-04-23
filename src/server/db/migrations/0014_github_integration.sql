-- GitHub PR reviewer integration: per-user credentials + task dedup key.

CREATE TABLE IF NOT EXISTS "user_integrations" (
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "external_id" text,
  "token" text NOT NULL,
  "poll_interval_minutes" integer NOT NULL DEFAULT 5,
  "last_polled_at" timestamp,
  "last_poll_error" text,
  "created_at" timestamp NOT NULL DEFAULT NOW(),
  "updated_at" timestamp NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("user_id", "provider")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "external_ref" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_user_external_ref_idx"
  ON "tasks" ("user_id", "external_ref")
  WHERE "external_ref" IS NOT NULL;
