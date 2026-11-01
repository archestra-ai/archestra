CREATE TABLE "device_mcp_command" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"tool_name" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"result" jsonb,
	"result_digest" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_mcp_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"catalog_id" uuid NOT NULL,
	"name" text NOT NULL,
	"config_digest" text NOT NULL,
	"config_version" text NOT NULL,
	"pairing_hash" text,
	"pairing_expires_at" timestamp NOT NULL,
	"token_hash" text,
	"token_expires_at" timestamp,
	"session_id" uuid,
	"last_seen_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "device_mcp_connection_pairing_hash_unique" UNIQUE("pairing_hash"),
	CONSTRAINT "device_mcp_connection_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "device_config" jsonb;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "device_mcp_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "device_mcp_command" ADD CONSTRAINT "device_mcp_command_device_id_device_mcp_connection_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device_mcp_connection"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "device_mcp_command" VALIDATE CONSTRAINT "device_mcp_command_device_id_device_mcp_connection_id_fk";--> statement-breakpoint
ALTER TABLE "device_mcp_connection" ADD CONSTRAINT "device_mcp_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "device_mcp_connection" VALIDATE CONSTRAINT "device_mcp_connection_organization_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "device_mcp_connection" ADD CONSTRAINT "device_mcp_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "device_mcp_connection" VALIDATE CONSTRAINT "device_mcp_connection_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "device_mcp_connection" ADD CONSTRAINT "device_mcp_connection_catalog_id_internal_mcp_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."internal_mcp_catalog"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "device_mcp_connection" VALIDATE CONSTRAINT "device_mcp_connection_catalog_id_internal_mcp_catalog_id_fk";--> statement-breakpoint
CREATE INDEX "device_mcp_command_poll_idx" ON "device_mcp_command" USING btree ("device_id","session_id","status");--> statement-breakpoint
CREATE INDEX "device_mcp_owner_idx" ON "device_mcp_connection" USING btree ("organization_id","user_id","catalog_id");