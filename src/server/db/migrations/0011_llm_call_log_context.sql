-- Extend llm_call_log with the context the admin UI needs: who made the
-- call, what model answered, token usage for cost/usage dashboards, and
-- the prompt/response themselves so the operator can inspect individual
-- calls when something looks off. All new columns are nullable — rows
-- written before this migration (and any future caller that doesn't pass
-- these fields) simply have nulls.

ALTER TABLE "llm_call_log"
  ADD COLUMN IF NOT EXISTS "user_id" text,
  ADD COLUMN IF NOT EXISTS "model" text,
  ADD COLUMN IF NOT EXISTS "prompt_tokens" integer,
  ADD COLUMN IF NOT EXISTS "completion_tokens" integer,
  ADD COLUMN IF NOT EXISTS "total_tokens" integer,
  ADD COLUMN IF NOT EXISTS "messages" jsonb,
  ADD COLUMN IF NOT EXISTS "response" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_call_log_user_started_idx"
  ON "llm_call_log" ("user_id", "started_at");
