ALTER TABLE "runner_enrollments" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "runner_enrollments" ADD COLUMN "revoked_at" timestamp with time zone;