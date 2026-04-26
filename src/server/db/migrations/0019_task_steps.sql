-- Subtask checklist. Steps are templates attached to a task; completion
-- state lives per task_instance so a recurring parent's checklist resets
-- with each new instance. Each step grants a slice of the parent task's
-- base XP; the parent grants a smaller "completion bonus" when checked.

CREATE TABLE "task_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT NOW(),
  "updated_at" timestamp NOT NULL DEFAULT NOW()
);
CREATE INDEX "task_steps_task_position_idx" ON "task_steps" ("task_id", "position");
--> statement-breakpoint

CREATE TABLE "task_step_completions" (
  "instance_id" uuid NOT NULL REFERENCES "task_instances"("id") ON DELETE CASCADE,
  "step_id" uuid NOT NULL REFERENCES "task_steps"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "completed_at" timestamp NOT NULL DEFAULT NOW(),
  "xp_earned" integer NOT NULL,
  PRIMARY KEY ("instance_id", "step_id")
);
CREATE INDEX "task_step_completions_instance_idx" ON "task_step_completions" ("instance_id");
