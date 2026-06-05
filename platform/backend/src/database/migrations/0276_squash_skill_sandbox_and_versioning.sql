-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=sandbox tables are unreleased and are reset here (TRUNCATE/DROP, no rollout-safety concern); skills.latest_version is backfilled to 1 before SET NOT NULL and the new version/uniqueness tables start empty, so no existing row can violate them.
--
-- Squash of the branch's three sandbox migrations into one:
--   (A) unified skill_sandbox_files table (uploads + artifacts collapsed),
--   (B) immutable skill versioning (skill_versions + skill_version_files),
--   plus version-pinned skill mounts and the reshaped replay-event log.
--
-- Sandboxes are unreleased: their data is cleared (TRUNCATE) rather than
-- migrated. Skills are released: every existing skill is backfilled to v1
-- at the end of this migration.
TRUNCATE TABLE "skill_sandboxes" CASCADE;--> statement-breakpoint
CREATE TABLE "skill_sandbox_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"path" text NOT NULL,
	"mime_type" text NOT NULL,
	"original_name" text,
	"source_attachment_id" uuid,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_sandbox_files_id_kind_uidx" UNIQUE("id","kind")
);
--> statement-breakpoint
CREATE TABLE "skill_sandbox_replay_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"command_id" uuid,
	"file_id" uuid,
	"file_kind" text GENERATED ALWAYS AS ('upload') STORED,
	"skill_mount_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_sandbox_replay_events_one_payload_chk" CHECK ((
        ("skill_sandbox_replay_events"."command_id" IS NOT NULL)::int
        + ("skill_sandbox_replay_events"."file_id" IS NOT NULL)::int
        + ("skill_sandbox_replay_events"."skill_mount_id" IS NOT NULL)::int
      ) = 1)
);
--> statement-breakpoint
CREATE TABLE "skill_sandbox_skill_mounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"skill_version_id" uuid NOT NULL,
	"skill_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_sandbox_skill_mounts_sandbox_skill_uidx" UNIQUE("sandbox_id","skill_id"),
	CONSTRAINT "skill_sandbox_skill_mounts_sandbox_name_uidx" UNIQUE("sandbox_id","skill_name")
);
--> statement-breakpoint
CREATE TABLE "skill_version_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"encoding" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_sandbox_artifacts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_sandbox_file_snapshots" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_sandbox_skills" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "skill_sandbox_artifacts" CASCADE;--> statement-breakpoint
DROP TABLE "skill_sandbox_file_snapshots" CASCADE;--> statement-breakpoint
DROP TABLE "skill_sandbox_skills" CASCADE;--> statement-breakpoint
ALTER TABLE "skill_sandboxes" DROP CONSTRAINT "skill_sandboxes_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "skill_sandboxes" DROP CONSTRAINT "skill_sandboxes_primary_skill_id_skills_id_fk";
--> statement-breakpoint
ALTER TABLE "skill_sandboxes" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_sandboxes" ADD COLUMN "next_replay_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- nullable first; backfilled to 1 and set NOT NULL at the end of this migration.
ALTER TABLE "skills" ADD COLUMN "latest_version" integer;--> statement-breakpoint
ALTER TABLE "skill_sandbox_files" ADD CONSTRAINT "skill_sandbox_files_sandbox_id_skill_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."skill_sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandbox_replay_events" ADD CONSTRAINT "skill_sandbox_replay_events_sandbox_id_skill_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."skill_sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandbox_replay_events" ADD CONSTRAINT "skill_sandbox_replay_events_command_id_skill_sandbox_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."skill_sandbox_commands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandbox_replay_events" ADD CONSTRAINT "skill_sandbox_replay_events_skill_mount_id_skill_sandbox_skill_mounts_id_fk" FOREIGN KEY ("skill_mount_id") REFERENCES "public"."skill_sandbox_skill_mounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandbox_replay_events" ADD CONSTRAINT "skill_sandbox_replay_events_file_fk" FOREIGN KEY ("file_id","file_kind") REFERENCES "public"."skill_sandbox_files"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandbox_skill_mounts" ADD CONSTRAINT "skill_sandbox_skill_mounts_sandbox_id_skill_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."skill_sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandbox_skill_mounts" ADD CONSTRAINT "skill_sandbox_skill_mounts_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_version_files" ADD CONSTRAINT "skill_version_files_version_id_skill_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_sandbox_files_sandbox_id_idx" ON "skill_sandbox_files" USING btree ("sandbox_id");--> statement-breakpoint
CREATE INDEX "skill_sandbox_files_sandbox_kind_idx" ON "skill_sandbox_files" USING btree ("sandbox_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_sandbox_files_sandbox_attachment_uidx" ON "skill_sandbox_files" USING btree ("sandbox_id","source_attachment_id") WHERE "skill_sandbox_files"."source_attachment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "skill_sandbox_replay_events_sandbox_id_idx" ON "skill_sandbox_replay_events" USING btree ("sandbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_sandbox_replay_events_sandbox_sequence_uidx" ON "skill_sandbox_replay_events" USING btree ("sandbox_id","sequence");--> statement-breakpoint
CREATE INDEX "skill_sandbox_skill_mounts_sandbox_id_idx" ON "skill_sandbox_skill_mounts" USING btree ("sandbox_id");--> statement-breakpoint
CREATE INDEX "skill_version_files_version_id_idx" ON "skill_version_files" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_version_files_version_path_uidx" ON "skill_version_files" USING btree ("version_id","path");--> statement-breakpoint
CREATE INDEX "skill_versions_skill_id_idx" ON "skill_versions" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_version_uidx" ON "skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_sandboxes_default_uidx" ON "skill_sandboxes" USING btree ("organization_id","user_id","conversation_id") WHERE "skill_sandboxes"."is_default";--> statement-breakpoint
ALTER TABLE "skill_sandboxes" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "skill_sandboxes" DROP COLUMN "primary_skill_id";--> statement-breakpoint
-- backfill version 1 for every existing skill. content_hash is a sentinel: the
-- canonical hash is computed in app code (sha256 over body + files), impractical
-- to reproduce in SQL across pg/PGlite. The only effect is that the first edit
-- to a skill after this migration always forks v2 even if unchanged — a one-time,
-- harmless extra version; identical edits are suppressed from then on.
INSERT INTO "skill_versions" ("skill_id", "version", "content", "content_hash")
	SELECT "id", 1, "content", 'backfill' FROM "skills";--> statement-breakpoint
INSERT INTO "skill_version_files" ("version_id", "path", "content", "encoding", "kind")
	SELECT sv."id", sf."path", sf."content", sf."encoding", sf."kind"
	FROM "skill_files" sf
	JOIN "skill_versions" sv ON sv."skill_id" = sf."skill_id" AND sv."version" = 1;--> statement-breakpoint
UPDATE "skills" SET "latest_version" = 1;--> statement-breakpoint
ALTER TABLE "skills" ALTER COLUMN "latest_version" SET NOT NULL;