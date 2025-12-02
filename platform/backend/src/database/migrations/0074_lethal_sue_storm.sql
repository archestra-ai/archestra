ALTER TABLE "internal_mcp_catalog" ADD COLUMN "client_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD CONSTRAINT "internal_mcp_catalog_client_secret_id_fkey" FOREIGN KEY ("client_secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;
