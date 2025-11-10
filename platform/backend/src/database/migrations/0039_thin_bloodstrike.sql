CREATE TABLE "mcp_server_user" (
	"mcp_server_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_server_user_mcp_server_id_user_id_pk" PRIMARY KEY("mcp_server_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "agent_tools" ADD COLUMN "credential_source_mcp_server_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "auth_type" text;--> statement-breakpoint
ALTER TABLE "mcp_server_user" ADD CONSTRAINT "mcp_server_user_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_user" ADD CONSTRAINT "mcp_server_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_credential_source_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("credential_source_mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;