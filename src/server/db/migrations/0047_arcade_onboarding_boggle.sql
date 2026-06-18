-- Arcade onboarding for Boggle. Same shape as 0031: grant every existing user
-- 1 token and seed a "Try the Boggle game" task so they discover it.
-- Idempotent via the event reason key and tasks.external_ref.

WITH granted AS (
  INSERT INTO "events" ("user_id", "type", "payload", "occurred_at")
  SELECT u."id",
         'tokens.granted',
         jsonb_build_object(
           'amount', 1,
           'reason', 'onboarding:arcade-boggle',
           'grantedBy', 'system'
         ),
         NOW()
  FROM "user" u
  WHERE NOT EXISTS (
    SELECT 1 FROM "events" e
    WHERE e."user_id" = u."id"
      AND e."type" = 'tokens.granted'
      AND e."payload"->>'reason' = 'onboarding:arcade-boggle'
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
         'Try the Boggle game',
         E'Head to the arcade and spend a token on Boggle — trace adjacent letters to build words against a 3-minute clock. Longer words score more, and "Qu" counts as two letters.',
         'small',
         'onboarding-try-boggle',
         'private'
  FROM "user" u
  WHERE NOT EXISTS (
    SELECT 1 FROM "tasks" t
    WHERE t."user_id" = u."id" AND t."external_ref" = 'onboarding-try-boggle'
  )
  RETURNING "id", "user_id"
)
INSERT INTO "task_instances" ("task_id", "user_id", "due_at")
SELECT "id", "user_id", NOW() FROM new_tasks;
