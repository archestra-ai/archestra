-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=all flagged constraints and unique indexes target the brand-new apps/app_versions/app_tools/app_data/app_team/app_render_diagnostics/app_render_screenshots tables created in this migration (no existing rows); the only existing-table change is mcp_tool_calls gaining a defaulted owner_type column and a nullable app_id column, whose FK validates trivially because every existing row is NULL.
CREATE TABLE "app_data" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" text,
	"key" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"owner_user_id" text,
	"value" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_render_diagnostics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"entries" jsonb NOT NULL,
	"rendered_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_render_screenshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"mime_type" text NOT NULL,
	"data" text NOT NULL,
	"rendered_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_team" (
	"app_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_team_app_id_team_id_pk" PRIMARY KEY("app_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "app_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"mcp_server_id" uuid,
	"credential_resolution_mode" text DEFAULT 'static' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_tools_app_id_tool_id_unique" UNIQUE("app_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "app_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid,
	"version" integer NOT NULL,
	"html" text NOT NULL,
	"ui_permissions" jsonb,
	"content_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"author_id" text,
	"scope" text DEFAULT 'personal' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"template_id" text,
	"latest_version" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD COLUMN "owner_type" varchar(16) DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD COLUMN "app_id" uuid;--> statement-breakpoint
ALTER TABLE "app_data" ADD CONSTRAINT "app_data_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_data" ADD CONSTRAINT "app_data_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_data" ADD CONSTRAINT "app_data_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_render_diagnostics" ADD CONSTRAINT "app_render_diagnostics_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_render_diagnostics" ADD CONSTRAINT "app_render_diagnostics_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_render_screenshots" ADD CONSTRAINT "app_render_screenshots_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_render_screenshots" ADD CONSTRAINT "app_render_screenshots_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_team" ADD CONSTRAINT "app_team_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_team" ADD CONSTRAINT "app_team_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_tools" ADD CONSTRAINT "app_tools_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_tools" ADD CONSTRAINT "app_tools_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_tools" ADD CONSTRAINT "app_tools_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_versions" ADD CONSTRAINT "app_versions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_data_app_id_user_id_idx" ON "app_data" USING btree ("app_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_data_shared_partition_key_idx" ON "app_data" USING btree ("app_id","key") WHERE "app_data"."user_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "app_data_user_partition_key_idx" ON "app_data" USING btree ("app_id","user_id","key") WHERE "app_data"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "app_render_diagnostics_app_user_idx" ON "app_render_diagnostics" USING btree ("app_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_render_screenshots_app_user_idx" ON "app_render_screenshots" USING btree ("app_id","user_id");--> statement-breakpoint
CREATE INDEX "app_versions_app_id_idx" ON "app_versions" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_versions_app_version_uidx" ON "app_versions" USING btree ("app_id","version");--> statement-breakpoint
CREATE INDEX "apps_organization_id_idx" ON "apps" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "apps_scope_idx" ON "apps" USING btree ("scope");--> statement-breakpoint
CREATE UNIQUE INDEX "apps_org_personal_name_idx" ON "apps" USING btree ("organization_id","author_id","name") WHERE "apps"."scope" = 'personal' AND "apps"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "apps_org_shared_name_idx" ON "apps" USING btree ("organization_id","name") WHERE "apps"."scope" in ('team', 'org') AND "apps"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_tool_calls_app_id_idx" ON "mcp_tool_calls" USING btree ("app_id");