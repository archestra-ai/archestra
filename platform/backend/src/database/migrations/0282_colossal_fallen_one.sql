-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=brand-new tables (connection_setups, connection_setup_skills) have no existing rows, so their FK/unique constraints and indexes cannot fail; CASCADE deletes are intentional for these ephemeral render tickets. Added columns are nullable or have safe defaults (agents.is_personal_proxy default false, organization.connection_default_provider_keys nullable). The partial unique index on agents has no existing personal-proxy rows to conflict.
CREATE TABLE "connection_setup_skills" (
	"connection_setup_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	CONSTRAINT "connection_setup_skills_connection_setup_id_skill_id_pk" PRIMARY KEY("connection_setup_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "connection_setups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"base_url" text NOT NULL,
	"mcp_gateway_id" uuid,
	"llm_proxy_id" uuid,
	"provider" text,
	"proxy_auth" text DEFAULT 'provider-key' NOT NULL,
	"virtual_api_key_id" uuid,
	"include_skills" boolean DEFAULT false NOT NULL,
	"skill_link_ttl_days" integer,
	"skill_share_link_id" uuid,
	"token_hash" text NOT NULL,
	"token_start" varchar(22) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "is_personal_proxy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "connection_default_provider_keys" jsonb;--> statement-breakpoint
ALTER TABLE "connection_setup_skills" ADD CONSTRAINT "connection_setup_skills_connection_setup_id_connection_setups_id_fk" FOREIGN KEY ("connection_setup_id") REFERENCES "public"."connection_setups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_setup_skills" ADD CONSTRAINT "connection_setup_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_setups" ADD CONSTRAINT "connection_setups_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_setups" ADD CONSTRAINT "connection_setups_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_setups" ADD CONSTRAINT "connection_setups_mcp_gateway_id_agents_id_fk" FOREIGN KEY ("mcp_gateway_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_setups" ADD CONSTRAINT "connection_setups_llm_proxy_id_agents_id_fk" FOREIGN KEY ("llm_proxy_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_setups" ADD CONSTRAINT "connection_setups_virtual_api_key_id_virtual_api_keys_id_fk" FOREIGN KEY ("virtual_api_key_id") REFERENCES "public"."virtual_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_setups" ADD CONSTRAINT "connection_setups_skill_share_link_id_skill_share_link_id_fk" FOREIGN KEY ("skill_share_link_id") REFERENCES "public"."skill_share_link"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_setup_skills_skill_id_idx" ON "connection_setup_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_setups_token_hash_idx" ON "connection_setups" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "connection_setups_org_id_idx" ON "connection_setups" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "connection_setups_token_start_idx" ON "connection_setups" USING btree ("token_start");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_personal_proxy_per_member_idx" ON "agents" USING btree ("organization_id","author_id") WHERE "agents"."agent_type" = 'llm_proxy' AND "agents"."is_personal_proxy" = true AND "agents"."deleted_at" IS NULL;