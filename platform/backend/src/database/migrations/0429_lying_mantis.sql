-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Both MCP Skill tables are created empty, so their validating foreign keys and non-concurrent indexes are immediate. internal_mcp_catalog is a bounded metadata table; existing rows intentionally start at generation zero.
CREATE TABLE "external_mcp_skill_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"uri" text NOT NULL,
	"user_id" text,
	"session_id" text,
	"context_tokens" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_catalog_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_id" uuid NOT NULL,
	"uri" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resources" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "skills_refresh_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "external_mcp_skill_usage_events" ADD CONSTRAINT "external_mcp_skill_usage_events_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_catalog_skills" ADD CONSTRAINT "mcp_catalog_skills_catalog_id_internal_mcp_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."internal_mcp_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_skill_usage_server_uri_created_idx" ON "external_mcp_skill_usage_events" USING btree ("mcp_server_id","uri","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_catalog_skills_catalog_uri_uidx" ON "mcp_catalog_skills" USING btree ("catalog_id","uri");--> statement-breakpoint
CREATE INDEX "mcp_catalog_skills_catalog_idx" ON "mcp_catalog_skills" USING btree ("catalog_id");
