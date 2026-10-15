-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The constraint and index target openappa_root_openings, a table created empty in this same migration: the add-validating-constraint rule scans no existing rows, and CONCURRENTLY is unnecessary on a brand-new empty table. ON DELETE cascade is intentional (a root's recorded opening means nothing without its organization). The added openappa_effective_policies column is nullable with no default.
CREATE TABLE "openappa_root_openings" (
	"root" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"policy_file_key" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "openappa_effective_policies" ADD COLUMN "retained_annotators" jsonb;--> statement-breakpoint
ALTER TABLE "openappa_root_openings" ADD CONSTRAINT "openappa_root_openings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "openappa_root_openings_org_key_idx" ON "openappa_root_openings" USING btree ("organization_id","policy_file_key");