-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=This migration creates kb_external_groups as an empty table and adds its foreign key and indexes before any writer can insert rows, so no existing row can violate any constraint. ON DELETE CASCADE intentionally removes connector-owned group snapshots when their connector is deleted. The table is empty while the non-concurrent indexes are created, so they cannot block production writes.
CREATE TABLE "kb_external_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connector_id" uuid NOT NULL,
	"connector_type" text NOT NULL,
	"group_id" text NOT NULL,
	"name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_external_groups" ADD CONSTRAINT "kb_external_groups_connector_id_knowledge_base_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."knowledge_base_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_external_groups_unique_idx" ON "kb_external_groups" USING btree ("connector_id","group_id");--> statement-breakpoint
CREATE INDEX "kb_external_groups_connector_id_idx" ON "kb_external_groups" USING btree ("connector_id");