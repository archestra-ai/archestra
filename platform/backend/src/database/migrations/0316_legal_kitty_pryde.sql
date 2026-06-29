ALTER TABLE "environments" ADD COLUMN "trusted_image_registries" jsonb;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "catalog_item_approval_status" text;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "catalog_item_approval_reason" text;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "catalog_item_approval_reviewed_by" text;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "catalog_item_approval_reviewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_environment_trusted_image_registries" jsonb;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD CONSTRAINT "internal_mcp_catalog_catalog_item_approval_reviewed_by_user_id_fk" FOREIGN KEY ("catalog_item_approval_reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;