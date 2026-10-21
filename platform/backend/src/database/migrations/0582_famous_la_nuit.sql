CREATE TABLE "mcp_server_tool_descriptions" (
	"mcp_server_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"description" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_server_tool_descriptions_mcp_server_id_tool_id_pk" PRIMARY KEY("mcp_server_id","tool_id")
);
--> statement-breakpoint
ALTER TABLE "mcp_server_tool_descriptions" ADD CONSTRAINT "mcp_server_tool_descriptions_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "mcp_server_tool_descriptions" VALIDATE CONSTRAINT "mcp_server_tool_descriptions_mcp_server_id_mcp_server_id_fk";--> statement-breakpoint
ALTER TABLE "mcp_server_tool_descriptions" ADD CONSTRAINT "mcp_server_tool_descriptions_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "mcp_server_tool_descriptions" VALIDATE CONSTRAINT "mcp_server_tool_descriptions_tool_id_tools_id_fk";--> statement-breakpoint
CREATE INDEX "mcp_server_tool_descriptions_tool_id_idx" ON "mcp_server_tool_descriptions" USING btree ("tool_id");