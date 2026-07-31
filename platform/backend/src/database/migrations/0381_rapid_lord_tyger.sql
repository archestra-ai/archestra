-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=every flagged statement (FK, unique index, plain index, cascade) targets the brand-new empty agent_versions table created in this migration; the only existing-table change is agents gaining a defaulted latest_version column, which is metadata-only. ON DELETE CASCADE is intentional: version snapshots have no consumer once the agent row is hard-deleted (nothing pins an agent version, unlike skill mounts).
CREATE TABLE "agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "latest_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_versions_agent_id_idx" ON "agent_versions" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_versions_agent_version_uidx" ON "agent_versions" USING btree ("agent_id","version");