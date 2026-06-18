-- A second, household-focused LLM blurb for the weekly summary. Lives in the
-- same per-(user, week) cache row as the personal analysis but in its own
-- columns, so the family recap (this week vs last week, all members) can be
-- regenerated independently and is absent (NULL) for users with no household.

ALTER TABLE "weekly_summaries"
  ADD COLUMN IF NOT EXISTS "household_analysis" text;

ALTER TABLE "weekly_summaries"
  ADD COLUMN IF NOT EXISTS "household_generated_at" timestamptz;
