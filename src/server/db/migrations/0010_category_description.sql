-- Add free-form description to user categories so users can give the AI
-- extra context about what belongs in each category.

ALTER TABLE "user_categories"
  ADD COLUMN IF NOT EXISTS "description" text NOT NULL DEFAULT '';
