CREATE TABLE "finding_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"evidence_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"retention_mode" text NOT NULL,
	"quote" text,
	CONSTRAINT "evidence_privacy" CHECK ("finding_evidence"."retention_mode" = 'indexed' or ("finding_evidence"."retention_mode" = 'ephemeral' and "finding_evidence"."quote" is null))
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"file_path" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"retention_mode" text NOT NULL,
	"explanation" text,
	"replacement" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "findings_organization_id_repository_id_id_unique" UNIQUE("organization_id","repository_id","id"),
	CONSTRAINT "findings_run_id_fingerprint_unique" UNIQUE("run_id","fingerprint"),
	CONSTRAINT "finding_privacy" CHECK ("findings"."retention_mode" = 'indexed' or ("findings"."retention_mode" = 'ephemeral' and "findings"."explanation" is null and "findings"."replacement" is null))
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" bigint PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "model_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"credential_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"capabilities" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_profiles_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "organization_members_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_account_id" bigint NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_github_account_id_unique" UNIQUE("github_account_id")
);
--> statement-breakpoint
CREATE TABLE "provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"encrypted" jsonb NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_credentials_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "publication_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"head_sha" text NOT NULL,
	"digest" text NOT NULL,
	"marker" text NOT NULL,
	"state" text DEFAULT 'PREPARED' NOT NULL,
	"remote_review_id" bigint,
	"remote_check_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_attempts_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "published_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"remote_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "published_comments_organization_id_repository_id_remote_id_unique" UNIQUE("organization_id","repository_id","remote_id")
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"organization_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"state" text NOT NULL,
	"draft" boolean NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_requests_organization_id_repository_id_number_pk" PRIMARY KEY("organization_id","repository_id","number")
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"github_repository_id" bigint NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"retention_mode" text DEFAULT 'ephemeral' NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_github_repository_id_unique" UNIQUE("github_repository_id"),
	CONSTRAINT "repositories_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "repository_retention" CHECK ("repositories"."retention_mode" in ('ephemeral','indexed'))
);
--> statement-breakpoint
CREATE TABLE "repository_configs" (
	"organization_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"config_sha" text NOT NULL,
	"config_hash" text NOT NULL,
	"configuration" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_configs_organization_id_repository_id_version_pk" PRIMARY KEY("organization_id","repository_id","version")
);
--> statement-breakpoint
CREATE TABLE "review_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"pull_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"config_hash" text NOT NULL,
	"generation" integer NOT NULL,
	"state" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"retention_mode" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_runs_organization_id_repository_id_id_unique" UNIQUE("organization_id","repository_id","id"),
	CONSTRAINT "review_runs_organization_id_repository_id_pull_number_head_sha_config_hash_generation_unique" UNIQUE("organization_id","repository_id","pull_number","head_sha","config_hash","generation")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_user_id_unique" UNIQUE("github_user_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finding_evidence" ADD CONSTRAINT "finding_evidence_organization_id_repository_id_finding_id_findings_organization_id_repository_id_id_fk" FOREIGN KEY ("organization_id","repository_id","finding_id") REFERENCES "public"."findings"("organization_id","repository_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_organization_id_repository_id_run_id_review_runs_organization_id_repository_id_id_fk" FOREIGN KEY ("organization_id","repository_id","run_id") REFERENCES "public"."review_runs"("organization_id","repository_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_profiles" ADD CONSTRAINT "model_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_profiles" ADD CONSTRAINT "model_profiles_organization_id_credential_id_provider_credentials_organization_id_id_fk" FOREIGN KEY ("organization_id","credential_id") REFERENCES "public"."provider_credentials"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_attempts" ADD CONSTRAINT "publication_attempts_organization_id_repository_id_run_id_review_runs_organization_id_repository_id_id_fk" FOREIGN KEY ("organization_id","repository_id","run_id") REFERENCES "public"."review_runs"("organization_id","repository_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_comments" ADD CONSTRAINT "published_comments_organization_id_repository_id_run_id_review_runs_organization_id_repository_id_id_fk" FOREIGN KEY ("organization_id","repository_id","run_id") REFERENCES "public"."review_runs"("organization_id","repository_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_organization_id_repository_id_repositories_organization_id_id_fk" FOREIGN KEY ("organization_id","repository_id") REFERENCES "public"."repositories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_organization_id_installation_id_github_installations_organization_id_id_fk" FOREIGN KEY ("organization_id","installation_id") REFERENCES "public"."github_installations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_configs" ADD CONSTRAINT "config_repository_scope" FOREIGN KEY ("organization_id","repository_id") REFERENCES "public"."repositories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_organization_id_repository_id_repositories_organization_id_id_fk" FOREIGN KEY ("organization_id","repository_id") REFERENCES "public"."repositories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_state_idx" ON "review_runs" USING btree ("state","created_at");