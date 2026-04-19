-- Audit log of outbound LLM calls. Used by the admin dashboard to watch
-- latency and success rate against the single LM Studio instance.

CREATE TABLE IF NOT EXISTS "llm_call_log" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "started_at" timestamp DEFAULT now() NOT NULL,
  "duration_ms" integer NOT NULL,
  "success" boolean NOT NULL,
  "error_message" text,
  CONSTRAINT "llm_call_log_pk" PRIMARY KEY ("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_call_log_started_idx"
  ON "llm_call_log" ("started_at");
