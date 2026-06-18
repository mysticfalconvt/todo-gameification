-- Configurable delivery time for the weekly summary email. Previously the
-- send was hardcoded to Monday 08:00 local; these columns let each user pick
-- the weekday and local hour. Defaults preserve the old behavior (Monday 8am)
-- so existing opted-in users see no change until they edit it.
--
--   weekly_email_dow   ISO weekday 1..7 (1 = Monday … 7 = Sunday).
--   weekly_email_hour  local hour 0..23.

ALTER TABLE "user_prefs"
  ADD COLUMN IF NOT EXISTS "weekly_email_dow" smallint NOT NULL DEFAULT 1
    CHECK ("weekly_email_dow" BETWEEN 1 AND 7);

ALTER TABLE "user_prefs"
  ADD COLUMN IF NOT EXISTS "weekly_email_hour" smallint NOT NULL DEFAULT 8
    CHECK ("weekly_email_hour" BETWEEN 0 AND 23);
