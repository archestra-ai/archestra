-- Two coupled changes: (A) collapse skill_sandbox_uploads + skill_sandbox_artifacts
-- into one role-tagged skill_sandbox_files table; (B) add immutable skill
-- versioning and pin sandbox mounts to a version.
--
-- Sandbox tables are unreleased, so their data is dropped (TRUNCATE/DROP).
-- Skills are released, so every existing skill is backfilled to version 1.

-- === B1: version tables (created first so the backfill below can target them) ===
CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
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
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_version_files" ADD CONSTRAINT "skill_version_files_version_id_skill_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_versions_skill_id_idx" ON "skill_versions" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_version_uidx" ON "skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE INDEX "skill_version_files_version_id_idx" ON "skill_version_files" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_version_files_version_path_uidx" ON "skill_version_files" USING btree ("version_id","path");--> statement-breakpoint

-- === B2: skills.latest_version (nullable -> backfill -> NOT NULL) ===
ALTER TABLE "skills" ADD COLUMN "latest_version" integer;--> statement-breakpoint
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
ALTER TABLE "skills" ALTER COLUMN "latest_version" SET NOT NULL;--> statement-breakpoint

-- === A + mount pinning: clear unreleased sandbox state, then reshape ===
-- TRUNCATE clears sandboxes + every child (mounts, uploads, artifacts, commands,
-- replay events, snapshots), so the NOT NULL mount column added below is safe.
TRUNCATE TABLE "skill_sandboxes" CASCADE;--> statement-breakpoint

ALTER TABLE "skill_sandbox_artifacts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_sandbox_file_snapshots" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_sandbox_uploads" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "skill_sandbox_artifacts" CASCADE;--> statement-breakpoint
DROP TABLE "skill_sandbox_file_snapshots" CASCADE;--> statement-breakpoint
DROP TABLE "skill_sandbox_uploads" CASCADE;--> statement-breakpoint

CREATE TABLE "skill_sandbox_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"path" text NOT NULL,
	"mime_type" text NOT NULL,
	"original_name" text,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_sandbox_files_id_kind_uidx" UNIQUE("id","kind")
);
--> statement-breakpoint
ALTER TABLE "skill_sandbox_files" ADD CONSTRAINT "skill_sandbox_files_sandbox_id_skill_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."skill_sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_sandbox_files_sandbox_id_idx" ON "skill_sandbox_files" USING btree ("sandbox_id");--> statement-breakpoint
CREATE INDEX "skill_sandbox_files_sandbox_kind_idx" ON "skill_sandbox_files" USING btree ("sandbox_id","kind");--> statement-breakpoint

-- replay events: upload_id -> file_id + generated file_kind + composite FK.
ALTER TABLE "skill_sandbox_replay_events" DROP CONSTRAINT "skill_sandbox_replay_events_one_payload_chk";--> statement-breakpoint
-- dropping the column also drops its (auto-named, length-truncated) upload FK.
ALTER TABLE "skill_sandbox_replay_events" DROP COLUMN "upload_id";--> statement-breakpoint
ALTER TABLE "skill_sandbox_replay_events" ADD COLUMN "file_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_sandbox_replay_events" ADD COLUMN "file_kind" text GENERATED ALWAYS AS ('upload') STORED;--> statement-breakpoint
ALTER TABLE "skill_sandbox_replay_events" ADD CONSTRAINT "skill_sandbox_replay_events_file_fk" FOREIGN KEY ("file_id","file_kind") REFERENCES "public"."skill_sandbox_files"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandbox_replay_events" ADD CONSTRAINT "skill_sandbox_replay_events_one_payload_chk" CHECK ((
        ("skill_sandbox_replay_events"."command_id" IS NOT NULL)::int
        + ("skill_sandbox_replay_events"."file_id" IS NOT NULL)::int
        + ("skill_sandbox_replay_events"."skill_mount_id" IS NOT NULL)::int
      ) = 1);--> statement-breakpoint

-- mounts: pin a version (NOT NULL, safe — table emptied above) + the two uniques.
ALTER TABLE "skill_sandbox_skill_mounts" ADD COLUMN "skill_version_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_sandbox_skill_mounts" ADD CONSTRAINT "skill_sandbox_skill_mounts_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandbox_skill_mounts" ADD CONSTRAINT "skill_sandbox_skill_mounts_sandbox_skill_uidx" UNIQUE("sandbox_id","skill_id");--> statement-breakpoint
ALTER TABLE "skill_sandbox_skill_mounts" ADD CONSTRAINT "skill_sandbox_skill_mounts_sandbox_name_uidx" UNIQUE("sandbox_id","skill_name");
