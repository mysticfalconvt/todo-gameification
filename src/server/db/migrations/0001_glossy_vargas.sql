ALTER TABLE "tasks" ADD COLUMN "time_of_day" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;