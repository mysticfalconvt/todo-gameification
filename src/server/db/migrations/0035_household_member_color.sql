-- Per-member color used to tint chore rows in the household UI and
-- color-code the per-member series in the household stats charts.
-- Nullable: existing rows pick a default at first-write time via
-- pickDefaultColor() in services/households.ts. New rows get a default
-- assigned in createHousehold / acceptInvite.

ALTER TABLE "household_members"
  ADD COLUMN IF NOT EXISTS "color" text;
--> statement-breakpoint

-- Backfill existing memberships with a palette-cycled value indexed by
-- join order within the household. Same eight colors the service uses.
WITH ordered AS (
  SELECT
    household_id,
    user_id,
    row_number() OVER (
      PARTITION BY household_id ORDER BY joined_at, user_id
    ) - 1 AS idx
  FROM "household_members"
  WHERE color IS NULL
),
palette AS (
  SELECT i, color FROM (VALUES
    (0, '#4fb8b2'),
    (1, '#f59e0b'),
    (2, '#a855f7'),
    (3, '#ef4444'),
    (4, '#22c55e'),
    (5, '#0ea5e9'),
    (6, '#ec4899'),
    (7, '#facc15')
  ) AS p(i, color)
)
UPDATE "household_members" hm
SET color = palette.color
FROM ordered, palette
WHERE hm.household_id = ordered.household_id
  AND hm.user_id = ordered.user_id
  AND palette.i = ordered.idx % 8;
