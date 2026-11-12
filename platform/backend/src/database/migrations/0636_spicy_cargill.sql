-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Creates three new, empty tables (desktop_devices, desktop_device_servers and desktop_mcp_requests), so their foreign keys and unique indexes validate nothing and block no writer. The one change to an existing table adds a nullable column (internal_mcp_catalog.desktop_config). Removing an organization, a user or a catalog item removes their devices and device servers, and removing a device removes its waiting MCP messages, through the foreign keys; that is intended.
CREATE TABLE "desktop_device_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"catalog_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"state" text,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desktop_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_polled_at" timestamp,
	"client_version" text,
	"client_target" text,
	"client_sha256" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desktop_mcp_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"response" jsonb,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "desktop_config" jsonb;--> statement-breakpoint
ALTER TABLE "desktop_device_servers" ADD CONSTRAINT "desktop_device_servers_device_id_desktop_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."desktop_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_device_servers" ADD CONSTRAINT "desktop_device_servers_catalog_id_internal_mcp_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."internal_mcp_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_devices" ADD CONSTRAINT "desktop_devices_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_devices" ADD CONSTRAINT "desktop_devices_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_mcp_requests" ADD CONSTRAINT "desktop_mcp_requests_device_id_desktop_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."desktop_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_device_servers_device_catalog_idx" ON "desktop_device_servers" USING btree ("device_id","catalog_id");--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_devices_user_id_idx" ON "desktop_devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_devices_key_hash_idx" ON "desktop_devices" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "desktop_devices_org_id_idx" ON "desktop_devices" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "desktop_mcp_requests_device_status_created_idx" ON "desktop_mcp_requests" USING btree ("device_id","status","created_at");