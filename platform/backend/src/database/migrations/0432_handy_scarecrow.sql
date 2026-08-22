-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=All flagged foreign keys, unique indexes, and non-concurrent indexes target Plugin tables created empty in this same migration. The two skill_share_link columns are nullable, and the task single-flight index only matches the new plugin_github_sync task type that no older writer can create. CASCADE removes only Plugin-owned junction/file rows with their parent.
CREATE TABLE "connection_setup_plugins" (
	"connection_setup_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	CONSTRAINT "connection_setup_plugins_connection_setup_id_plugin_id_pk" PRIMARY KEY("connection_setup_id","plugin_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"encoding" text DEFAULT 'utf8' NOT NULL,
	"mode" text DEFAULT '100644' NOT NULL,
	"digest" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_team" (
	"plugin_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_team_plugin_id_team_id_pk" PRIMARY KEY("plugin_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_user" (
	"plugin_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_user_plugin_id_user_id_pk" PRIMARY KEY("plugin_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"author_id" text,
	"scope" text DEFAULT 'org' NOT NULL,
	"client_type" text NOT NULL,
	"supported_platforms" text[] DEFAULT '{"posix"}' NOT NULL,
	"plugin_slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"content_hash" text NOT NULL,
	"source_kind" text DEFAULT 'manual' NOT NULL,
	"source_repo" text,
	"source_ref" text,
	"source_sha" text,
	"source_subdir" text,
	"source_exclude" text[] DEFAULT '{}' NOT NULL,
	"source_marketplace_repo" text,
	"source_marketplace_path" text,
	"source_marketplace_plugin_name" text,
	"github_sync_interval" text,
	"github_sync_ref" text,
	"github_app_config_id" uuid,
	"github_pat_id" uuid,
	"last_synced_at" timestamp,
	"last_sync_error" text,
	"pending_source_sha" text,
	"pending_content_hash" text,
	"pending_detected_at" timestamp,
	"sync_generation" integer DEFAULT 0 NOT NULL,
	"source_id" text,
	"approved_content_hash" text,
	"approved_at" timestamp,
	"approved_by" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "skill_share_link_plugins" (
	"share_link_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_share_link_plugins_share_link_id_plugin_id_pk" PRIMARY KEY("share_link_id","plugin_id")
);
--> statement-breakpoint
ALTER TABLE "skill_share_link" ADD COLUMN "plugin_client_type" text;--> statement-breakpoint
ALTER TABLE "skill_share_link" ADD COLUMN "plugin_platform" text;--> statement-breakpoint
ALTER TABLE "connection_setup_plugins" ADD CONSTRAINT "connection_setup_plugins_connection_setup_id_connection_setups_id_fk" FOREIGN KEY ("connection_setup_id") REFERENCES "public"."connection_setups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_setup_plugins" ADD CONSTRAINT "connection_setup_plugins_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_files" ADD CONSTRAINT "plugin_files_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_team" ADD CONSTRAINT "plugin_team_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_team" ADD CONSTRAINT "plugin_team_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_user" ADD CONSTRAINT "plugin_user_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_user" ADD CONSTRAINT "plugin_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_github_app_config_id_github_app_configs_id_fk" FOREIGN KEY ("github_app_config_id") REFERENCES "public"."github_app_configs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_github_pat_id_github_pats_id_fk" FOREIGN KEY ("github_pat_id") REFERENCES "public"."github_pats"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_share_link_plugins" ADD CONSTRAINT "skill_share_link_plugins_share_link_id_skill_share_link_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."skill_share_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_share_link_plugins" ADD CONSTRAINT "skill_share_link_plugins_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_setup_plugins_plugin_id_idx" ON "connection_setup_plugins" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_files_plugin_id_idx" ON "plugin_files" USING btree ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_files_plugin_path_uidx" ON "plugin_files" USING btree ("plugin_id","path");--> statement-breakpoint
CREATE INDEX "plugins_organization_id_idx" ON "plugins" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "plugins_scope_idx" ON "plugins" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "plugins_github_sync_due_idx" ON "plugins" USING btree ("last_synced_at") WHERE "plugins"."github_sync_interval" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "plugins_org_client_type_idx" ON "plugins" USING btree ("organization_id","client_type");--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_org_plugin_slug_uidx" ON "plugins" USING btree ("organization_id","plugin_slug") WHERE "plugins"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_source_id_uidx" ON "plugins" USING btree ("organization_id","source_id") WHERE "plugins"."source_id" IS NOT NULL AND "plugins"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_org_marketplace_entry_uidx" ON "plugins" USING btree ("organization_id",lower("source_marketplace_repo"),"source_marketplace_path",lower("source_marketplace_plugin_name")) WHERE "plugins"."source_marketplace_repo" IS NOT NULL AND "plugins"."source_marketplace_path" IS NOT NULL AND "plugins"."source_marketplace_plugin_name" IS NOT NULL AND "plugins"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "skill_share_link_plugins_plugin_id_idx" ON "skill_share_link_plugins" USING btree ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_plugin_github_sync_single_flight_idx" ON "tasks" USING btree (("payload" ->> 'pluginId')) WHERE "tasks"."task_type" = 'plugin_github_sync' AND "tasks"."status" IN ('pending', 'processing');
