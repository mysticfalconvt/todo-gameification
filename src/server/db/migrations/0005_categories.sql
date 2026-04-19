-- Custom migration: drop free-form tags, replace with a single LLM-assigned
-- category per task plus a per-user taxonomy table.

ALTER TABLE "tasks" DROP COLUMN IF EXISTS "tags";
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "category_slug" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_categories" (
  "user_id" text NOT NULL,
  "slug" text NOT NULL,
  "label" text NOT NULL,
  "color" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "user_categories_user_id_slug_pk" PRIMARY KEY ("user_id", "slug")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_categories" ADD CONSTRAINT "user_categories_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
