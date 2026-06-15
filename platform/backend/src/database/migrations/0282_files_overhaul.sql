CREATE TYPE "public"."project_share_visibility" AS ENUM('organization', 'team');--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"folder_id" uuid,
	"conversation_id" uuid,
	"sandbox_id" uuid,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_provider" text DEFAULT 'db' NOT NULL,
	"data" "bytea",
	"object_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "files_storage_payload_chk" CHECK ((
        ("files"."storage_provider" = 'db' AND "files"."data" IS NOT NULL AND "files"."object_key" IS NULL)
        OR ("files"."storage_provider" = 'filesystem' AND "files"."object_key" IS NOT NULL AND "files"."data" IS NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
ALTER TABLE "skill_sandbox_files" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_sandbox_id_skill_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."skill_sandboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_team" ADD CONSTRAINT "project_share_team_share_id_project_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."project_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_team" ADD CONSTRAINT "project_share_team_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_shares" ADD CONSTRAINT "project_shares_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_organization_id_idx" ON "files" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "files_user_id_idx" ON "files" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "files_folder_id_idx" ON "files" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "files_conversation_id_idx" ON "files" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "files_sandbox_id_idx" ON "files" USING btree ("sandbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "folders_user_name_uidx" ON "folders" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_user_name_uidx" ON "projects" USING btree ("user_id","name");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Data migration: move persistent My Files out of skill_sandbox_files
-- (kind='artifact') into the new files table, ids/bytes/timestamps verbatim so
-- /api/skill-sandbox/artifacts/:id URLs keep working, then drop the old rows.
-- The producing sandbox's user IS the author (what the old listing derived
-- through the join); folder_id is null because folders don't exist on main.
INSERT INTO "files" (
  "id", "organization_id", "user_id",
  "folder_id", "conversation_id", "sandbox_id",
  "filename", "mime_type", "size_bytes",
  "storage_provider", "data", "object_key", "created_at"
)
SELECT
  f."id",
  sb."organization_id",
  sb."user_id",
  NULL,
  sb."conversation_id",
  f."sandbox_id",
  COALESCE(f."original_name", NULLIF(regexp_replace(f."path", '^.*/', ''), ''), 'file'),
  f."mime_type",
  f."size_bytes",
  'db',
  f."data",
  NULL,
  f."created_at"
FROM "skill_sandbox_files" f
JOIN "skill_sandboxes" sb ON sb."id" = f."sandbox_id"
WHERE f."kind" = 'artifact';--> statement-breakpoint
DELETE FROM "skill_sandbox_files" WHERE "kind" = 'artifact';