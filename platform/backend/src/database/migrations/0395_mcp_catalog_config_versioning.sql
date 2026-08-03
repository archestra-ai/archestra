-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=every flagged statement (FK, unique index, plain index, cascade) targets the brand-new empty mcp_catalog_versions table created in this migration; the only existing-table changes are internal_mcp_catalog gaining the defaulted latest_version and revision columns, which are metadata-only. ON DELETE CASCADE is intentional: version snapshots have no consumer once the catalog row is hard-deleted (nothing pins a catalog version, same rationale as agent_versions).
CREATE TABLE "mcp_catalog_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "latest_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_catalog_versions" ADD CONSTRAINT "mcp_catalog_versions_catalog_id_internal_mcp_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."internal_mcp_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_catalog_versions_catalog_id_idx" ON "mcp_catalog_versions" USING btree ("catalog_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_catalog_versions_catalog_version_uidx" ON "mcp_catalog_versions" USING btree ("catalog_id","version");