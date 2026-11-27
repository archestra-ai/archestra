-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Both foreign keys and both unique indexes are on plugin_versions and plugin_version_files, which this migration creates empty, so they validate no existing rows and no older writer writes to them. The backfill below runs after them and inserts one version per plugin, which cannot repeat a (plugin_id, version) or a (version_id, path): plugin_files is already unique on (plugin_id, path).
CREATE TABLE "plugin_version_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"encoding" text NOT NULL,
	"mode" text NOT NULL,
	"digest" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"source_commit" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "frontmatter_source" text;--> statement-breakpoint
ALTER TABLE "plugin_version_files" ADD CONSTRAINT "plugin_version_files_version_id_plugin_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."plugin_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_versions" ADD CONSTRAINT "plugin_versions_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_version_files_version_id_idx" ON "plugin_version_files" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_version_files_version_path_uidx" ON "plugin_version_files" USING btree ("version_id","path");--> statement-breakpoint
CREATE INDEX "plugin_versions_plugin_id_idx" ON "plugin_versions" USING btree ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_versions_plugin_version_uidx" ON "plugin_versions" USING btree ("plugin_id","version");--> statement-breakpoint
-- Every plugin that exists starts its history at version 1, holding the files
-- it has now. Deleted plugins too: a restored plugin has its history.
INSERT INTO "plugin_versions" ("plugin_id", "version", "content_hash", "source_commit", "created_at")
SELECT "id", 1, "content_hash", "source_sha", "updated_at" FROM "plugins";--> statement-breakpoint
INSERT INTO "plugin_version_files" ("version_id", "path", "content", "encoding", "mode", "digest")
SELECT v."id", f."path", f."content", f."encoding", f."mode", f."digest"
FROM "plugin_files" f
JOIN "plugin_versions" v ON v."plugin_id" = f."plugin_id";
