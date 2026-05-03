-- Split the coach personality from its verbosity. Previously a single
-- "coach_attitude" enum mixed the two ("detailed" was both a length and a
-- voice). Now: attitude = personality (warm / snarky / stoic / drill / zen);
-- a separate boolean "coach_detailed" toggles the longer-response mode for
-- whichever personality is selected.

ALTER TABLE "user_prefs"
  ADD COLUMN "coach_detailed" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Anyone who picked the old "detailed" attitude was opting into longer
-- output; preserve that intent on the new boolean.
UPDATE "user_prefs"
  SET "coach_detailed" = true
  WHERE "coach_attitude" = 'detailed';
--> statement-breakpoint

-- Collapse both old "concise" (the warm voice with short output) and
-- "detailed" (same warm voice with long output) onto the renamed "warm"
-- personality. The verbosity flag now carries the length distinction.
UPDATE "user_prefs"
  SET "coach_attitude" = 'warm'
  WHERE "coach_attitude" IN ('concise', 'detailed');
--> statement-breakpoint

ALTER TABLE "user_prefs"
  ALTER COLUMN "coach_attitude" SET DEFAULT 'warm';
