-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=All constraints and unique indexes target the three openappa battery tables created empty in this migration, so validation scans no existing rows. Deleting an organization or an MCP catalog entry intentionally removes its battery installs, packages and composed policy.
CREATE TABLE "openappa_battery_installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"battery_name" text NOT NULL,
	"catalog_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"credential_bindings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openappa_battery_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content_hash" text NOT NULL,
	"files" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openappa_effective_policies" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"root_revision" integer NOT NULL,
	"install_fingerprint" text NOT NULL,
	"compiled_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "openappa_battery_installs" ADD CONSTRAINT "openappa_battery_installs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openappa_battery_installs" ADD CONSTRAINT "openappa_battery_installs_catalog_id_internal_mcp_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."internal_mcp_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openappa_battery_packages" ADD CONSTRAINT "openappa_battery_packages_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openappa_effective_policies" ADD CONSTRAINT "openappa_effective_policies_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "openappa_battery_installs_org_catalog_battery_idx" ON "openappa_battery_installs" USING btree ("organization_id","catalog_id","battery_name");--> statement-breakpoint
CREATE INDEX "openappa_battery_installs_catalog_idx" ON "openappa_battery_installs" USING btree ("catalog_id");--> statement-breakpoint
CREATE UNIQUE INDEX "openappa_battery_packages_org_name_idx" ON "openappa_battery_packages" USING btree ("organization_id","name");