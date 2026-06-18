-- Group-targeted chores: a free-for-all restricted to a role group so a
-- chore can be requested of "any adult" or "any kid" without naming a
-- specific person.
--
--   assignee_group  NULL       — no group (specific assignee via
--                                assigned_to_user_id, or plain
--                                free-for-all when that's also null).
--                   'adults'   — any adult (admin/member) may complete;
--                                kids are blocked.
--                   'kids'     — requested of the kids; a kid completes
--                                via the claim/approval queue, an adult
--                                may still complete on a kid's behalf.
--
-- Mutually exclusive with a specific assigned_to_user_id and with
-- round-robin (enforced in the service layer). Mirrored onto
-- task_instances so the completion gate / today queries don't join.

ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "assignee_group" text
    CHECK ("assignee_group" IN ('adults','kids'));

ALTER TABLE "task_instances"
  ADD COLUMN IF NOT EXISTS "assignee_group" text
    CHECK ("assignee_group" IN ('adults','kids'));
