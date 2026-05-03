-- Discriminator for the punctuality curve applied at completion.
--   'hard'        — strict deadline (existing behavior; default).
--   'week_target' — soft target day; bonus XP for finishing early, gentle
--                   penalty for finishing late, hard-late floor only after
--                   the surrounding week is over.
--
-- Lives on both tables: the parent "tasks" row carries the default for
-- future generated instances (so updateTask has a place to write); each
-- "task_instances" row carries the value that actually drives the
-- multiplier at completion.
ALTER TABLE "tasks"
  ADD COLUMN "due_kind" text NOT NULL DEFAULT 'hard';
--> statement-breakpoint

ALTER TABLE "task_instances"
  ADD COLUMN "due_kind" text NOT NULL DEFAULT 'hard';
