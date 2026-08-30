-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Bundle tables are created empty in this migration, so their constraints and indexes scan no existing rows. New nullable foreign keys and constant JSONB defaults on the low-volume connection setup and share-link tables use PostgreSQL metadata-only paths. Cascades intentionally revoke dependent memberships, setup tickets, and marketplace links with their Bundle.
CREATE TABLE "capability_bundle_plugins" (
	"capability_bundle_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	CONSTRAINT "capability_bundle_plugins_capability_bundle_id_plugin_id_pk" PRIMARY KEY("capability_bundle_id","plugin_id")
);
--> statement-breakpoint
CREATE TABLE "capability_bundle_skills" (
	"capability_bundle_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	CONSTRAINT "capability_bundle_skills_capability_bundle_id_skill_id_pk" PRIMARY KEY("capability_bundle_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "capability_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"mcp_gateway_id" uuid,
	"local_mcp_servers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connection_setups" ADD COLUMN "bundle_id" uuid;--> statement-breakpoint
ALTER TABLE "connection_setups" ADD COLUMN "selected_optional_local_mcp_server_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_share_link" ADD COLUMN "bundle_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_share_link" ADD COLUMN "selected_optional_local_mcp_server_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "capability_bundle_plugins" ADD CONSTRAINT "capability_bundle_plugins_capability_bundle_id_capability_bundles_id_fk" FOREIGN KEY ("capability_bundle_id") REFERENCES "public"."capability_bundles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_bundle_plugins" ADD CONSTRAINT "capability_bundle_plugins_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_bundle_skills" ADD CONSTRAINT "capability_bundle_skills_capability_bundle_id_capability_bundles_id_fk" FOREIGN KEY ("capability_bundle_id") REFERENCES "public"."capability_bundles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_bundle_skills" ADD CONSTRAINT "capability_bundle_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_bundles" ADD CONSTRAINT "capability_bundles_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_bundles" ADD CONSTRAINT "capability_bundles_mcp_gateway_id_agents_id_fk" FOREIGN KEY ("mcp_gateway_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capability_bundle_plugins_plugin_id_idx" ON "capability_bundle_plugins" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "capability_bundle_skills_skill_id_idx" ON "capability_bundle_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "capability_bundles_organization_id_idx" ON "capability_bundles" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capability_bundles_org_name_uidx" ON "capability_bundles" USING btree ("organization_id","name");--> statement-breakpoint
ALTER TABLE "connection_setups" ADD CONSTRAINT "connection_setups_bundle_id_capability_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."capability_bundles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_share_link" ADD CONSTRAINT "skill_share_link_bundle_id_capability_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."capability_bundles"("id") ON DELETE cascade ON UPDATE no action;
