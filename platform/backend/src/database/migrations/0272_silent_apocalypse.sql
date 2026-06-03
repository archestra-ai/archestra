CREATE TABLE "skill_sandbox_replay_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"command_id" uuid,
	"upload_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_sandbox_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"path" text NOT NULL,
	"mime_type" text NOT NULL,
	"original_name" text,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_sandboxes" ADD COLUMN "next_replay_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_sandbox_replay_events" ADD CONSTRAINT "skill_sandbox_replay_events_sandbox_id_skill_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."skill_sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandbox_replay_events" ADD CONSTRAINT "skill_sandbox_replay_events_command_id_skill_sandbox_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."skill_sandbox_commands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandbox_replay_events" ADD CONSTRAINT "skill_sandbox_replay_events_upload_id_skill_sandbox_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."skill_sandbox_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandbox_uploads" ADD CONSTRAINT "skill_sandbox_uploads_sandbox_id_skill_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."skill_sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_sandbox_replay_events_sandbox_id_idx" ON "skill_sandbox_replay_events" USING btree ("sandbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_sandbox_replay_events_sandbox_sequence_uidx" ON "skill_sandbox_replay_events" USING btree ("sandbox_id","sequence");--> statement-breakpoint
CREATE INDEX "skill_sandbox_uploads_sandbox_id_idx" ON "skill_sandbox_uploads" USING btree ("sandbox_id");--> statement-breakpoint
-- backfill: every pre-existing command becomes an ordered replay event,
-- preserving (created_at, id) order per sandbox. uploads did not exist before
-- this migration, so the command log is the complete history to replay.
INSERT INTO "skill_sandbox_replay_events" ("sandbox_id", "organization_id", "sequence", "kind", "command_id", "created_at")
SELECT
	c."sandbox_id",
	c."organization_id",
	(ROW_NUMBER() OVER (PARTITION BY c."sandbox_id" ORDER BY c."created_at", c."id") - 1)::integer,
	'command',
	c."id",
	c."created_at"
FROM "skill_sandbox_commands" c;--> statement-breakpoint
-- advance each sandbox's allocator past the events just backfilled.
UPDATE "skill_sandboxes" s
SET "next_replay_sequence" = sub."cnt"
FROM (
	SELECT "sandbox_id", COUNT(*)::integer AS "cnt"
	FROM "skill_sandbox_commands"
	GROUP BY "sandbox_id"
) sub
WHERE s."id" = sub."sandbox_id";