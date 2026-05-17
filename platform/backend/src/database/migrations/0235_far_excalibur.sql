ALTER TABLE "internal_mcp_catalog" ADD COLUMN "parent_catalog_item_id" uuid;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "child_name" text;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "preset_field_values" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "preset_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD CONSTRAINT "internal_mcp_catalog_parent_catalog_item_id_internal_mcp_catalog_id_fk" FOREIGN KEY ("parent_catalog_item_id") REFERENCES "public"."internal_mcp_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD CONSTRAINT "internal_mcp_catalog_preset_secret_id_secret_id_fk" FOREIGN KEY ("preset_secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "internal_mcp_catalog_parent_id_idx" ON "internal_mcp_catalog" USING btree ("parent_catalog_item_id");--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD CONSTRAINT "internal_mcp_catalog_parent_name_unique" UNIQUE("parent_catalog_item_id","name");