-- Arcade onboarding for 2048 + Sliding Puzzle. Same shape as 0017: grant
-- every existing user enough tokens to try the new games and seed a
-- "Try the …" task per game so they actually discover them. Idempotent via
-- the event reason key and tasks.external_ref.

-- 2 tokens per user (1 per new game).
WITH granted AS (
  INSERT INTO "events" ("user_id", "type", "payload", "occurred_at")
  SELECT u."id",
         'tokens.granted',
         jsonb_build_object(
           'amount', 2,
           'reason', 'onboarding:arcade-2048-sliding',
           'grantedBy', 'system'
         ),
         NOW()
  FROM "user" u
  WHERE NOT EXISTS (
    SELECT 1 FROM "events" e
    WHERE e."user_id" = u."id"
      AND e."type" = 'tokens.granted'
      AND e."payload"->>'reason' = 'onboarding:arcade-2048-sliding'
  )
  RETURNING "user_id"
)
INSERT INTO "progression" ("user_id", "tokens")
SELECT "user_id", 2 FROM granted
ON CONFLICT ("user_id") DO UPDATE
  SET "tokens" = "progression"."tokens" + 2,
      "updated_at" = NOW();
--> statement-breakpoint

-- "Try the 2048 game" task, one per user.
WITH new_tasks AS (
  INSERT INTO "tasks" ("user_id", "title", "notes", "difficulty", "external_ref", "visibility")
  SELECT u."id",
         'Try the 2048 game',
         E'Head to the arcade and spend a token on 2048 — slide tiles to merge matching pairs. Reach 1024 to win; higher tiles earn more XP.',
         'small',
         'onboarding-try-2048',
         'private'
  FROM "user" u
  WHERE NOT EXISTS (
    SELECT 1 FROM "tasks" t
    WHERE t."user_id" = u."id" AND t."external_ref" = 'onboarding-try-2048'
  )
  RETURNING "id", "user_id"
)
INSERT INTO "task_instances" ("task_id", "user_id", "due_at")
SELECT "id", "user_id", NOW() FROM new_tasks;
--> statement-breakpoint

-- "Try the Sliding Puzzle game" task, one per user.
WITH new_tasks AS (
  INSERT INTO "tasks" ("user_id", "title", "notes", "difficulty", "external_ref", "visibility")
  SELECT u."id",
         'Try the Sliding Puzzle game',
         E'Head to the arcade and spend a token on Sliding Puzzle — order the 8 tiles. Fewer moves = more XP.',
         'small',
         'onboarding-try-sliding-puzzle',
         'private'
  FROM "user" u
  WHERE NOT EXISTS (
    SELECT 1 FROM "tasks" t
    WHERE t."user_id" = u."id" AND t."external_ref" = 'onboarding-try-sliding-puzzle'
  )
  RETURNING "id", "user_id"
)
INSERT INTO "task_instances" ("task_id", "user_id", "due_at")
SELECT "id", "user_id", NOW() FROM new_tasks;
