-- Per-flow presence flags for GitHub PR tasks. The github sync re-
-- instances a completed task only when `assignee_present` transitions
-- from an explicit `false` back to `true` (the user was removed as the
-- PR's assignee and then re-added). Existing rows start at NULL — the
-- next poll fills them in, and the explicit-false guard prevents
-- spurious re-instancing on that first poll.
ALTER TABLE tasks ADD COLUMN assignee_present boolean;
ALTER TABLE tasks ADD COLUMN review_requested_present boolean;
