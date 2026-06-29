CREATE TABLE "mcp_preset_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_preset_entry_org_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "preset_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "preset_entity_name" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "preset_entity_name_plural" text;--> statement-breakpoint
ALTER TABLE "mcp_preset_entry" ADD CONSTRAINT "mcp_preset_entry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_preset_entry_org_idx" ON "mcp_preset_entry" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD CONSTRAINT "internal_mcp_catalog_preset_entry_id_mcp_preset_entry_id_fk" FOREIGN KEY ("preset_entry_id") REFERENCES "public"."mcp_preset_entry"("id") ON DELETE cascade ON UPDATE no action;