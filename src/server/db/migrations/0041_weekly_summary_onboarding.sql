-- Weekly summary onboarding: give every existing user a task pointing them
-- at the new /weekly-summary page (with a note to enable the Monday email
-- in Settings). Dedup-keyed by tasks.external_ref so this is idempotent and
-- future runs won't double-issue. New users get the same task via
-- src/server/services/onboarding.ts (ONBOARDING_TASKS).

WITH new_tasks AS (
  INSERT INTO "tasks" ("user_id", "title", "notes", "difficulty", "category_slug", "external_ref", "visibility")
  SELECT u."id",
         'Check out your weekly summary',
         E'A recap of your completions, streaks, habits, arcade runs, and how you stack up against friends — with a short AI review of your week. See it here: https://todo.rboskind.com/weekly-summary — and flip on the Monday email from the Settings page if you want it in your inbox.',
         'small',
         'other',
         'onboarding-weekly-summary',
         'private'
  FROM "user" u
  WHERE NOT EXISTS (
    SELECT 1 FROM "tasks" t
    WHERE t."user_id" = u."id" AND t."external_ref" = 'onboarding-weekly-summary'
  )
  RETURNING "id", "user_id"
)
INSERT INTO "task_instances" ("task_id", "user_id", "due_at")
SELECT "id", "user_id", NOW() FROM new_tasks;
