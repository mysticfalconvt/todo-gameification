-- v0.4 Social: handles, profile visibility, friendships, user_prefs.

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "handle" text;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "profile_visibility" text NOT NULL DEFAULT 'friends';
--> statement-breakpoint

-- Backfill existing users with a deterministic, safe placeholder handle
-- derived from their id. 'u_' prefix + first 8 id chars. User ids from
-- better-auth are ascii-safe (cuid/uuid-style). Users can edit later.
UPDATE "user"
SET "handle" = 'u_' || substr(replace(lower("id"), '-', ''), 1, 8)
WHERE "handle" IS NULL;
--> statement-breakpoint

-- Unlikely collision path: if two ids collapse to the same prefix, extend
-- with a tail segment so the unique constraint can be applied.
WITH dupes AS (
  SELECT "id", "handle",
         row_number() OVER (PARTITION BY "handle" ORDER BY "id") AS rn
  FROM "user"
)
UPDATE "user" u
SET "handle" = u."handle" || '_' || substr(replace(lower(u."id"), '-', ''), 9, 4)
FROM dupes d
WHERE d."id" = u."id" AND d.rn > 1;
--> statement-breakpoint

ALTER TABLE "user" ALTER COLUMN "handle" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_handle_unique" ON "user" (lower("handle"));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "friendships" (
  "requester_id" text NOT NULL,
  "addressee_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "responded_at" timestamp,
  CONSTRAINT "friendships_pk" PRIMARY KEY ("requester_id", "addressee_id"),
  CONSTRAINT "friendships_no_self" CHECK ("requester_id" <> "addressee_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "friendships" ADD CONSTRAINT "friendships_requester_fk"
    FOREIGN KEY ("requester_id") REFERENCES "public"."user"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "friendships" ADD CONSTRAINT "friendships_addressee_fk"
    FOREIGN KEY ("addressee_id") REFERENCES "public"."user"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "friendships_addressee_status_idx"
  ON "friendships" ("addressee_id", "status");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "user_prefs" (
  "user_id" text PRIMARY KEY,
  "share_progression" boolean NOT NULL DEFAULT true,
  "share_activity" boolean NOT NULL DEFAULT true,
  "share_task_titles" boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_prefs" ADD CONSTRAINT "user_prefs_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."user"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
