CREATE TABLE "runner_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"repository_ids" uuid[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_enrollments_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "runner_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"runner_id" uuid,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	"fence" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"result_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_leases_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"credential_hash" text NOT NULL,
	"repository_ids" uuid[] NOT NULL,
	"capabilities" jsonb NOT NULL,
	"last_heartbeat" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runners_credential_hash_unique" UNIQUE("credential_hash"),
	CONSTRAINT "runners_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "runner_enrollments" ADD CONSTRAINT "runner_enrollments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_leases" ADD CONSTRAINT "runner_leases_organization_id_repository_id_run_id_review_runs_organization_id_repository_id_id_fk" FOREIGN KEY ("organization_id","repository_id","run_id") REFERENCES "public"."review_runs"("organization_id","repository_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_leases" ADD CONSTRAINT "runner_leases_organization_id_runner_id_runners_organization_id_id_fk" FOREIGN KEY ("organization_id","runner_id") REFERENCES "public"."runners"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lease_claim_idx" ON "runner_leases" USING btree ("organization_id","state","expires_at");