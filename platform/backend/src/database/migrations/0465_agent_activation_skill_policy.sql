-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=agent_activation_skill_rules is created empty in this migration, so its foreign key, unique indexes, and ordinary index validate/build before any writer can insert data. ON DELETE CASCADE is intentional because policy rules have no meaning after their owning agent is permanently deleted. The two agents columns are constant-default metadata additions on PostgreSQL 11+ and preserve existing behavior (All mode, revision zero); the mode check is added in the same migration and the application accepts only 'all' or 'manual'.
CREATE TABLE "agent_activation_skill_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"disposition" text NOT NULL,
	"source" text NOT NULL,
	"skill_id" uuid,
	"mcp_server_id" uuid,
	"uri" text,
	"plugin_id" uuid,
	"skill_path" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_activation_skill_rules_disposition_check" CHECK ("agent_activation_skill_rules"."disposition" IN ('allow', 'exclude')),
	CONSTRAINT "agent_activation_skill_rules_reference_check" CHECK ((
        ("agent_activation_skill_rules"."source" = 'native' AND "agent_activation_skill_rules"."skill_id" IS NOT NULL AND "agent_activation_skill_rules"."mcp_server_id" IS NULL AND "agent_activation_skill_rules"."uri" IS NULL AND "agent_activation_skill_rules"."plugin_id" IS NULL AND "agent_activation_skill_rules"."skill_path" IS NULL)
        OR
        ("agent_activation_skill_rules"."source" = 'external_mcp' AND "agent_activation_skill_rules"."skill_id" IS NULL AND "agent_activation_skill_rules"."mcp_server_id" IS NOT NULL AND "agent_activation_skill_rules"."uri" IS NOT NULL AND "agent_activation_skill_rules"."plugin_id" IS NULL AND "agent_activation_skill_rules"."skill_path" IS NULL)
        OR
        ("agent_activation_skill_rules"."source" = 'plugin' AND "agent_activation_skill_rules"."skill_id" IS NULL AND "agent_activation_skill_rules"."mcp_server_id" IS NULL AND "agent_activation_skill_rules"."uri" IS NULL AND "agent_activation_skill_rules"."plugin_id" IS NOT NULL AND "agent_activation_skill_rules"."skill_path" IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "activation_skill_mode" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "activation_skill_policy_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_activation_skill_rules" ADD CONSTRAINT "agent_activation_skill_rules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_activation_skill_rules_agent_id_idx" ON "agent_activation_skill_rules" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_activation_skill_rules_native_uidx" ON "agent_activation_skill_rules" USING btree ("agent_id","disposition","skill_id") WHERE "agent_activation_skill_rules"."source" = 'native';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_activation_skill_rules_external_mcp_uidx" ON "agent_activation_skill_rules" USING btree ("agent_id","disposition","mcp_server_id","uri") WHERE "agent_activation_skill_rules"."source" = 'external_mcp';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_activation_skill_rules_plugin_uidx" ON "agent_activation_skill_rules" USING btree ("agent_id","disposition","plugin_id","skill_path") WHERE "agent_activation_skill_rules"."source" = 'plugin';--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_activation_skill_mode_check" CHECK ("agents"."activation_skill_mode" IN ('all', 'manual'));
