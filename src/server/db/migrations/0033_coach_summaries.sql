-- Persisted per-user cache for the daily coach blurb. Lets a fresh summary
-- generated on one device show up on another without a second LLM call.
-- generateCoachSummary upserts here on cache miss; the read path checks
-- signature + attitude + detailed + age against this row before deciding to
-- call the LLM again. resetTasks clears the row so a reset starts the coach
-- with no stale task references.
CREATE TABLE IF NOT EXISTS "coach_summaries" (
  "user_id" text PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "summary" text NOT NULL,
  "signature" text NOT NULL,
  "attitude" text NOT NULL,
  "detailed" boolean NOT NULL,
  "generated_at" timestamptz NOT NULL DEFAULT NOW()
);
