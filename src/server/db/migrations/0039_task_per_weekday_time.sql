-- Per-weekday time-of-day overrides for recurring tasks. JSON map of
-- '0'..'6' (Sun..Sat) -> 'HH:MM'; a weekday absent from the map uses the
-- task's base time_of_day. Nullable, so existing single-time tasks are
-- unaffected.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS time_by_weekday jsonb;
