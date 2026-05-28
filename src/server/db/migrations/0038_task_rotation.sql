-- Round-robin recurring chores. The admin can pick a subset of
-- household members (e.g. just the kids, not the parents) to share a
-- chore; each time the recurring instance materializes, it gets
-- assigned to the next person in the pool.
--
--   rotation_strategy   'fixed'        (default) — tasks.assigned_to_user_id
--                                      stays put across recurrences.
--                       'round_robin'  the next-instance materializer
--                                      walks rotation_pool starting after
--                                      last_assignee_cursor.
--   rotation_pool       jsonb array of user ids participating in the
--                       rotation (subset of household_members). Kiosks
--                       excluded by the service layer.
--   last_assignee_cursor  who got the most recent instance — the next
--                         materialization picks the user immediately
--                         after this one in rotation_pool (wraps).

ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "rotation_strategy" text NOT NULL DEFAULT 'fixed'
    CHECK ("rotation_strategy" IN ('fixed','round_robin')),
  ADD COLUMN IF NOT EXISTS "rotation_pool" jsonb,
  ADD COLUMN IF NOT EXISTS "last_assignee_cursor" text
    REFERENCES "user"("id") ON DELETE SET NULL;
