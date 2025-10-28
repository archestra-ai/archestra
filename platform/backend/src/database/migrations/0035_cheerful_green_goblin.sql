CREATE TABLE "mcp_server_user" (
	"mcp_server_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_server_user_mcp_server_id_user_id_pk" PRIMARY KEY("mcp_server_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "mcp_server_user" ADD CONSTRAINT "mcp_server_user_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_user" ADD CONSTRAINT "mcp_server_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;