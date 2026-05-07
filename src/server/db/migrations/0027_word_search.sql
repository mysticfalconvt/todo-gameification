-- Word Search arcade game: cache of LLM-generated themed word lists.
-- Keyed on (theme_key, size_bucket) so the same theme/size combo is only
-- generated once. Grids are built fresh per play from these word lists.

CREATE TABLE IF NOT EXISTS "word_search_word_lists" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "theme_key" text NOT NULL,
  "theme_display" text NOT NULL,
  "size_bucket" text NOT NULL,
  "words" jsonb NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "word_search_word_lists_theme_size_uq"
  ON "word_search_word_lists" ("theme_key", "size_bucket");
