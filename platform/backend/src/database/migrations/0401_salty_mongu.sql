ALTER TABLE "mcp_server" ADD COLUMN "browser_key_protected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "browser_key_fingerprint" text;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "browser_key_escrow" jsonb;