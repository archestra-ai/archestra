-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=All constraints and indexes target the empty policy test tables created in this migration; no existing rows are scanned or writers blocked. Organization deletion intentionally removes its test definitions and run evidence.
CREATE TABLE "openappa_policy_test_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openappa_policy_test_suites" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"directory" text DEFAULT 'traces' NOT NULL,
	"source_commit" text,
	"source_revision" uuid
);
--> statement-breakpoint
ALTER TABLE "openappa_policy_test_runs" ADD CONSTRAINT "openappa_policy_test_runs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openappa_policy_test_runs" ADD CONSTRAINT "openappa_policy_test_runs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openappa_policy_test_suites" ADD CONSTRAINT "openappa_policy_test_suites_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "openappa_policy_test_runs_org_created_idx" ON "openappa_policy_test_runs" USING btree ("organization_id","created_at");