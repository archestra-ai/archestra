CREATE TABLE "mcp_server_installation_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_catalog_id" text,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"request_reason" text,
	"custom_server_config" jsonb DEFAULT 'null'::jsonb,
	"admin_response" text,
	"reviewed_by" text,
	"reviewed_at" timestamp,
	"notes" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_server_installation_request" ADD CONSTRAINT "mcp_server_installation_request_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_installation_request" ADD CONSTRAINT "mcp_server_installation_request_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;