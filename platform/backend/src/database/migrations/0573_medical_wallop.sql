-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The foreign key and indexes target a table created empty in this same migration: the add-validating-constraint rule scans no existing rows, and CONCURRENTLY is unnecessary on a brand-new empty table. The foreign key to organization only takes a brief lock on that table to attach the trigger. The table is additive: the previous release ignores it. ON DELETE CASCADE matches every other OpenAPPA dataset table, whose rows belong to their organization.
CREATE TABLE "openappa_label_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"root" text NOT NULL,
	"session_id" text NOT NULL,
	"caller_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"call_id" text,
	"tool" text,
	"trust_before" text NOT NULL,
	"audience_before" text NOT NULL,
	"trust_after" text NOT NULL,
	"audience_after" text NOT NULL,
	"policy_revision" bigint
);
--> statement-breakpoint
ALTER TABLE "openappa_label_changes" ADD CONSTRAINT "openappa_label_changes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "openappa_label_changes_root_created_idx" ON "openappa_label_changes" USING btree ("root","created_at");--> statement-breakpoint
CREATE INDEX "openappa_label_changes_org_created_idx" ON "openappa_label_changes" USING btree ("organization_id","created_at");