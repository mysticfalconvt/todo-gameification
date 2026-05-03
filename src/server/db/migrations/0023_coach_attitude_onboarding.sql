-- Onboarding nudge for the new coach-attitude picker. Same shape as the
-- arcade onboarding migrations (0017, 0020): seed a one-time task per
-- existing user so they discover the new setting. Idempotent via
-- tasks.external_ref.

WITH new_tasks AS (
  INSERT INTO "tasks" ("user_id", "title", "notes", "difficulty", "external_ref", "visibility")
  SELECT u."id",
         'Try a new coach attitude',
         E'Your daily coach has personalities now — concise, detailed, snarky, stoic, drill sergeant, or zen. Pick one in Settings → Coach Attitude.',
         'small',
         'onboarding-coach-attitude',
         'private'
  FROM "user" u
  WHERE NOT EXISTS (
    SELECT 1 FROM "tasks" t
    WHERE t."user_id" = u."id" AND t."external_ref" = 'onboarding-coach-attitude'
  )
  RETURNING "id", "user_id"
)
INSERT INTO "task_instances" ("task_id", "user_id", "due_at")
SELECT "id", "user_id", NOW() FROM new_tasks;
