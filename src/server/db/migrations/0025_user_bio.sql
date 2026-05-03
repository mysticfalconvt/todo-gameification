-- Free-text "About you" the user writes for the coach. Capped at 500
-- chars in the input validator. Empty string for everyone by default; the
-- coach prompt only includes the bio block when it's non-empty.
ALTER TABLE "user_prefs"
  ADD COLUMN "bio" text NOT NULL DEFAULT '';
