ALTER TABLE "mcp_catalog" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "mcp_catalog" ADD COLUMN "repository" text;--> statement-breakpoint
ALTER TABLE "mcp_catalog" ADD COLUMN "installation_command" text;--> statement-breakpoint
ALTER TABLE "mcp_catalog" ADD COLUMN "requires_auth" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_catalog" ADD COLUMN "auth_description" text;--> statement-breakpoint
ALTER TABLE "mcp_catalog" ADD COLUMN "auth_fields" jsonb DEFAULT '[]'::jsonb;