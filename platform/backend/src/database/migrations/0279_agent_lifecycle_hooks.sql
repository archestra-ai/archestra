-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=brand-new table (hook_files); no existing rows, so the FK constraint and unique index cannot fail on any data, and the CREATE INDEX on an empty table does not block writes.
CREATE TABLE "hook_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"event" text NOT NULL,
	"file_name" text NOT NULL,
	"content" text NOT NULL,
	"requirements" text[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "hooks_debug_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hook_files" ADD CONSTRAINT "hook_files_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hook_files_agent_id_idx" ON "hook_files" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hook_files_agent_event_file_uidx" ON "hook_files" USING btree ("agent_id","event","file_name");