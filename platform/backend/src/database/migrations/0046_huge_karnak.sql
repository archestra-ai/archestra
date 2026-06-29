ALTER TABLE "tools" DROP CONSTRAINT "tools_agent_id_name_unique";--> statement-breakpoint
ALTER TABLE "tools" DROP CONSTRAINT "tools_mcp_server_id_mcp_server_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_tools" ADD COLUMN "execution_source_mcp_server_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "server_type" text NOT NULL DEFAULT 'local';--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "catalog_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_execution_source_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("execution_source_mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_catalog_id_internal_mcp_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."internal_mcp_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_catalog_id_name_agent_id_unique" UNIQUE("catalog_id","name","agent_id");