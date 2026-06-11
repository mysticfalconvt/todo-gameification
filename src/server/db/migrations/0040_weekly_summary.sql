-- Weekly summary feature: opt-in email flag, LLM analysis cache, send dedup.

ALTER TABLE "user_prefs"
  ADD COLUMN IF NOT EXISTS "weekly_email_opt_in" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "weekly_summaries" (
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "week_key" text NOT NULL,
  "analysis" text NOT NULL,
  "attitude" text NOT NULL,
  "generated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "weekly_summaries_pk" PRIMARY KEY ("user_id", "week_key")
);

CREATE TABLE IF NOT EXISTS "weekly_email_log" (
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "week_key" text NOT NULL,
  "sent_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "weekly_email_log_pk" PRIMARY KEY ("user_id", "week_key")
);
