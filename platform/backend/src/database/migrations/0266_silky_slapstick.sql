ALTER TABLE "internal_mcp_catalog" ADD COLUMN "cloned_from" uuid;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "cloned_pending_discovery" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD CONSTRAINT "internal_mcp_catalog_cloned_from_internal_mcp_catalog_id_fk" FOREIGN KEY ("cloned_from") REFERENCES "public"."internal_mcp_catalog"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "internal_mcp_catalog_cloned_from_idx" ON "internal_mcp_catalog" USING btree ("cloned_from");--> statement-breakpoint
CREATE INDEX "tools_cloned_pending_discovery_idx" ON "tools" USING btree ("cloned_pending_discovery");