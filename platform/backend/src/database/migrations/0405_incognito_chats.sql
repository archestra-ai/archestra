ALTER TABLE "conversations" ADD COLUMN "incognito" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "incognito_dek_fingerprint" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "incognito_escrow" jsonb;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "incognito_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD COLUMN "incognito_conversation_id" uuid;