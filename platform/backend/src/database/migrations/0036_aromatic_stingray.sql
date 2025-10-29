ALTER TABLE "mcp_server" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "auth_type" text;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;