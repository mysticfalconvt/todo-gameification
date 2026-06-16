-- Per-user GitHub sync flow toggles. Lets a user choose to track only PRs
-- where they're requested as a reviewer, only PRs assigned to them, or both
-- (the default, which matches the prior always-both behavior). Defaults keep
-- existing integrations unchanged.
ALTER TABLE user_integrations
  ADD COLUMN IF NOT EXISTS track_review_requested boolean NOT NULL DEFAULT true;
ALTER TABLE user_integrations
  ADD COLUMN IF NOT EXISTS track_assigned boolean NOT NULL DEFAULT true;
