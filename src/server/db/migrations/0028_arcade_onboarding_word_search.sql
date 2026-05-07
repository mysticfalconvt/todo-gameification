-- Arcade onboarding for Word Search. Same shape as 0017 / 0020: grant every
-- existing user 1 token and seed a "Try the Word Search game" task so they
-- discover it. Idempotent via the event reason key and tasks.external_ref.

WITH granted AS (
  INSERT INTO "events" ("user_id", "type", "payload", "occurred_at")
  SELECT u."id",
         'tokens.granted',
         jsonb_build_object(
           'amount', 1,
           'reason', 'onboarding:arcade-word-search',
           'grantedBy', 'system'
         ),
         NOW()
  FROM "user" u
  WHERE NOT EXISTS (
    SELECT 1 FROM "events" e
    WHERE e."user_id" = u."id"
      AND e."type" = 'tokens.granted'
      AND e."payload"->>'reason' = 'onboarding:arcade-word-search'
  )
  RETURNING "user_id"
)
INSERT INTO "progression" ("user_id", "tokens")
SELECT "user_id", 1 FROM granted
ON CONFLICT ("user_id") DO UPDATE
  SET "tokens" = "progression"."tokens" + 1,
      "updated_at" = NOW();
--> statement-breakpoint

WITH new_tasks AS (
  INSERT INTO "tasks" ("user_id", "title", "notes", "difficulty", "external_ref", "visibility")
  SELECT u."id",
         'Try the Word Search game',
         E'Head to the arcade and spend a token on Word Search — pick a theme (or write your own) and tap two ends of each hidden word. Find them all for full XP.',
         'small',
         'onboarding-try-word-search',
         'private'
  FROM "user" u
  WHERE NOT EXISTS (
    SELECT 1 FROM "tasks" t
    WHERE t."user_id" = u."id" AND t."external_ref" = 'onboarding-try-word-search'
  )
  RETURNING "id", "user_id"
)
INSERT INTO "task_instances" ("task_id", "user_id", "due_at")
SELECT "id", "user_id", NOW() FROM new_tasks;
