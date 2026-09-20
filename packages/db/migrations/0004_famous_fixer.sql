CREATE TABLE "publication_payloads" (
	"organization_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"run_id" uuid PRIMARY KEY NOT NULL,
	"retention_mode" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "publication_payloads" ADD CONSTRAINT "publication_payloads_organization_id_repository_id_run_id_review_runs_organization_id_repository_id_id_fk" FOREIGN KEY ("organization_id","repository_id","run_id") REFERENCES "public"."review_runs"("organization_id","repository_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publication_expiry_idx" ON "publication_payloads" USING btree ("expires_at");