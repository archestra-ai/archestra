-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=All constraints and indexes target openappa_yells, created empty in this migration. There are no existing rows to validate or deduplicate. Organization deletion intentionally removes its reports.
CREATE TABLE "openappa_yells" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"caller_id" text NOT NULL,
	"session_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"message" text NOT NULL,
	"with_trajectory" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reported_at" timestamp with time zone,
	"report_failed" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text
);
--> statement-breakpoint
ALTER TABLE "openappa_yells" ADD CONSTRAINT "openappa_yells_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "openappa_yells_call_idx" ON "openappa_yells" USING btree ("organization_id","caller_id","session_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "openappa_yells_status_idx" ON "openappa_yells" USING btree ("organization_id","resolved_at","created_at","id");