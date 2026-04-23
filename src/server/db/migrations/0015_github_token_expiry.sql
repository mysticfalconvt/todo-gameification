-- Track classic-PAT expiration so we can nudge the user before it breaks.
ALTER TABLE "user_integrations"
  ADD COLUMN IF NOT EXISTS "token_expires_at" timestamp;
