CREATE TABLE "explicit_learnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"scope_globs" text[] NOT NULL,
	"rule" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"outcome" text NOT NULL,
	"source" text NOT NULL,
	"actor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_run_id_fingerprint_outcome_source_unique" UNIQUE("run_id","fingerprint","outcome","source"),
	CONSTRAINT "feedback_outcome" CHECK ("feedback"."outcome" in ('accepted_suggestion','dismissed','manual_fix','false_positive','intentional_wording','resolved_by_new_commit','outdated')),
	CONSTRAINT "feedback_source" CHECK ("feedback"."source" in ('explicit','inferred'))
);
--> statement-breakpoint
ALTER TABLE "explicit_learnings" ADD CONSTRAINT "explicit_learnings_organization_id_repository_id_repositories_organization_id_id_fk" FOREIGN KEY ("organization_id","repository_id") REFERENCES "public"."repositories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_organization_id_repository_id_run_id_review_runs_organization_id_repository_id_id_fk" FOREIGN KEY ("organization_id","repository_id","run_id") REFERENCES "public"."review_runs"("organization_id","repository_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learning_scope_idx" ON "explicit_learnings" USING btree ("organization_id","repository_id","enabled");