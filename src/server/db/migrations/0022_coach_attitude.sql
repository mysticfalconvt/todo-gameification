-- Per-user coach attitude (personality for the daily coach blurb).
-- Defaults every user (new and existing) to 'concise', the previous
-- behavior — so this is a safe additive change.
ALTER TABLE "user_prefs"
  ADD COLUMN "coach_attitude" text NOT NULL DEFAULT 'concise';
