-- Per-email audit log used to rate-limit outbound transactional mail
-- (email verification + password reset) so a single target address can't
-- be spammed by anonymous actors hitting /auth/login or /auth/forgot-password
-- repeatedly.

CREATE TABLE IF NOT EXISTS "email_send_log" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "kind" text NOT NULL,
  "sent_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "email_send_log_pk" PRIMARY KEY ("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_send_log_email_kind_sent_idx"
  ON "email_send_log" ("email", "kind", "sent_at");
