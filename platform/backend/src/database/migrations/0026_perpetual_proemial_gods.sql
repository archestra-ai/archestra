ALTER TABLE "mcp_catalog" RENAME TO "internal_mcp_catalog";--> statement-breakpoint
ALTER TABLE "mcp_server" DROP CONSTRAINT "mcp_server_catalog_id_mcp_catalog_id_fk";
--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_catalog_id_internal_mcp_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."internal_mcp_catalog"("id") ON DELETE set null ON UPDATE no action;