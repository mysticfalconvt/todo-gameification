-- Arcade onboarding: give every existing user 2 tokens + a task to try each
-- of the current arcade games. Each grant/task is dedup-keyed (by event
-- reason and tasks.external_ref respectively) so this migration is
-- idempotent and future runs won't double-issue.

-- 2 tokens per user. Event is the source of truth (survives rebuildProgression);
-- progression bump applied only for users who actually got the new event.
WITH granted AS (
  INSERT INTO "events" ("user_id", "type", "payload", "occurred_at")
  SELECT u."id",
         'tokens.granted',
         jsonb_build_object(
           'amount', 2,
           'reason', 'onboarding:arcade-welcome',
           'grantedBy', 'system'
         ),
         NOW()
  FROM "user" u
  WHERE NOT EXISTS (
    SELECT 1 FROM "events" e
    WHERE e."user_id" = u."id"
      AND e."type" = 'tokens.granted'
      AND e."payload"->>'reason' = 'onboarding:arcade-welcome'
  )
  RETURNING "user_id"
)
INSERT INTO "progression" ("user_id", "tokens")
SELECT "user_id", 2 FROM granted
ON CONFLICT ("user_id") DO UPDATE
  SET "tokens" = "progression"."tokens" + 2,
      "updated_at" = NOW();
--> statement-breakpoint

-- "Try the Wordle game" task, one per user.
WITH new_tasks AS (
  INSERT INTO "tasks" ("user_id", "title", "notes", "difficulty", "external_ref", "visibility")
  SELECT u."id",
         'Try the Wordle game',
         E'Head to the arcade and spend a token on Wordle — guess a 5-letter word in 6 tries. Fewer guesses = more XP.',
         'small',
         'onboarding-try-wordle',
         'private'
  FROM "user" u
  WHERE NOT EXISTS (
    SELECT 1 FROM "tasks" t
    WHERE t."user_id" = u."id" AND t."external_ref" = 'onboarding-try-wordle'
  )
  RETURNING "id", "user_id"
)
INSERT INTO "task_instances" ("task_id", "user_id", "due_at")
SELECT "id", "user_id", NOW() FROM new_tasks;
--> statement-breakpoint

-- "Try the Memory Flip game" task, one per user.
WITH new_tasks AS (
  INSERT INTO "tasks" ("user_id", "title", "notes", "difficulty", "external_ref", "visibility")
  SELECT u."id",
         'Try the Memory Flip game',
         E'Head to the arcade and spend a token on Memory Flip — match 6 pairs before 6 mismatches.',
         'small',
         'onboarding-try-memory-flip',
         'private'
  FROM "user" u
  WHERE NOT EXISTS (
    SELECT 1 FROM "tasks" t
    WHERE t."user_id" = u."id" AND t."external_ref" = 'onboarding-try-memory-flip'
  )
  RETURNING "id", "user_id"
)
INSERT INTO "task_instances" ("task_id", "user_id", "due_at")
SELECT "id", "user_id", NOW() FROM new_tasks;
