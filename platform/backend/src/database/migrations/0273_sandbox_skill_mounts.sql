-- sandboxes are unreleased and the data model changed incompatibly (skills are
-- now ordered mounts, file snapshots are grouped by mount). there is no data to
-- preserve, so clear any pre-existing sandbox rows rather than backfill the new
-- NOT NULL skill_mount_id below. TRUNCATE ... CASCADE clears every child table.
TRUNCATE TABLE "skill_sandboxes" CASCADE;--> statement-breakpoint
CREATE TABLE "skill_sandbox_skill_mounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"skill_id" uuid NOT NULL,
	"skill_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_sandbox_skills" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "skill_sandbox_skills" CASCADE;--> statement-breakpoint
ALTER TABLE "skill_sandboxes" DROP CONSTRAINT "skill_sandboxes_primary_skill_id_skills_id_fk";
--> statement-breakpoint
ALTER TABLE "skill_sandbox_file_snapshots" ADD COLUMN "skill_mount_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_sandbox_replay_events" ADD COLUMN "skill_mount_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_sandboxes" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_sandbox_skill_mounts" ADD CONSTRAINT "skill_sandbox_skill_mounts_sandbox_id_skill_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."skill_sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_sandbox_skill_mounts_sandbox_id_idx" ON "skill_sandbox_skill_mounts" USING btree ("sandbox_id");--> statement-breakpoint
ALTER TABLE "skill_sandbox_file_snapshots" ADD CONSTRAINT "skill_sandbox_file_snapshots_skill_mount_id_skill_sandbox_skill_mounts_id_fk" FOREIGN KEY ("skill_mount_id") REFERENCES "public"."skill_sandbox_skill_mounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandbox_replay_events" ADD CONSTRAINT "skill_sandbox_replay_events_skill_mount_id_skill_sandbox_skill_mounts_id_fk" FOREIGN KEY ("skill_mount_id") REFERENCES "public"."skill_sandbox_skill_mounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_sandbox_file_snapshots_skill_mount_id_idx" ON "skill_sandbox_file_snapshots" USING btree ("skill_mount_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_sandboxes_default_uidx" ON "skill_sandboxes" USING btree ("organization_id","user_id","conversation_id") WHERE "skill_sandboxes"."is_default";--> statement-breakpoint
ALTER TABLE "skill_sandboxes" DROP COLUMN "primary_skill_id";--> statement-breakpoint
ALTER TABLE "skill_sandbox_replay_events" ADD CONSTRAINT "skill_sandbox_replay_events_one_payload_chk" CHECK ((
        ("skill_sandbox_replay_events"."command_id" IS NOT NULL)::int
        + ("skill_sandbox_replay_events"."upload_id" IS NOT NULL)::int
        + ("skill_sandbox_replay_events"."skill_mount_id" IS NOT NULL)::int
      ) = 1);