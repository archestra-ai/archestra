-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=projects/project_shares/project_share_team are brand-new empty tables (their FKs + unique indexes cannot fail existing rows) and conversations.project_id is a new all-NULL column whose FK validates trivially; user_id/team cascades mirror the existing conversation_shares family.
CREATE TYPE "public"."project_share_visibility" AS ENUM('organization', 'team');--> statement-breakpoint
CREATE TABLE "project_share_team" (
	"share_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_share_team_share_id_team_id_pk" PRIMARY KEY("share_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "project_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"visibility" "project_share_visibility" DEFAULT 'organization' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_shares_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"folder_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "project_share_team" ADD CONSTRAINT "project_share_team_share_id_project_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."project_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_team" ADD CONSTRAINT "project_share_team_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_shares" ADD CONSTRAINT "project_shares_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_folder_id_skill_sandbox_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."skill_sandbox_folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_user_name_uidx" ON "projects" USING btree ("user_id","name");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;