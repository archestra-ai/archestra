-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The new A2A tables start empty. Cascades encode ownership: organizations own agents and runs; agents own connections; agents, teams, and users own grant rows; connections own synthetic tools. The new tools delegation column is nullable and all-NULL for existing rows; its foreign key and partial unique index may inspect or lock tools but cannot reject existing rows.
CREATE TABLE "a2a_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"remote_agent_id" uuid NOT NULL,
	"selected_interface" jsonb NOT NULL,
	"security_requirement" jsonb,
	"auth_type" text DEFAULT 'none' NOT NULL,
	"auth_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "a2a_connections_auth_type_check" CHECK ("a2a_connections"."auth_type" in ('none', 'bearer', 'api_key')),
	CONSTRAINT "a2a_connections_secret_check" CHECK (("a2a_connections"."auth_type" = 'none' and "a2a_connections"."secret_id" is null) or ("a2a_connections"."auth_type" <> 'none' and "a2a_connections"."secret_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "a2a_outbound_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"parent_agent_id" uuid,
	"remote_agent_id" uuid,
	"connection_id" uuid,
	"tool_id" uuid,
	"user_id" text,
	"conversation_id" uuid,
	"tool_call_id" text,
	"message_id" text NOT NULL,
	"remote_task_id" text,
	"remote_context_id" text,
	"state" text NOT NULL,
	"target_name_snapshot" text NOT NULL,
	"interface_snapshot" jsonb NOT NULL,
	"error_code" text,
	"status_reason" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "a2a_remote_agent_teams" (
	"remote_agent_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "a2a_remote_agent_teams_remote_agent_id_team_id_pk" PRIMARY KEY("remote_agent_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "a2a_remote_agent_users" (
	"remote_agent_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "a2a_remote_agent_users_remote_agent_id_user_id_pk" PRIMARY KEY("remote_agent_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "a2a_remote_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"author_id" text,
	"scope" text DEFAULT 'org' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"discovery_mode" text NOT NULL,
	"discovery_url" text,
	"agent_card" jsonb NOT NULL,
	"card_hash" text NOT NULL,
	"last_discovered_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "a2a_remote_agents_discovery_mode_check" CHECK ("a2a_remote_agents"."discovery_mode" in ('well_known', 'card_url', 'inline_card')),
	CONSTRAINT "a2a_remote_agents_discovery_url_check" CHECK (("a2a_remote_agents"."discovery_mode" = 'inline_card' and "a2a_remote_agents"."discovery_url" is null) or ("a2a_remote_agents"."discovery_mode" <> 'inline_card' and "a2a_remote_agents"."discovery_url" is not null))
);
--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "delegate_to_a2a_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "a2a_connections" ADD CONSTRAINT "a2a_connections_remote_agent_id_a2a_remote_agents_id_fk" FOREIGN KEY ("remote_agent_id") REFERENCES "public"."a2a_remote_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_connections" ADD CONSTRAINT "a2a_connections_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_outbound_runs" ADD CONSTRAINT "a2a_outbound_runs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_outbound_runs" ADD CONSTRAINT "a2a_outbound_runs_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_outbound_runs" ADD CONSTRAINT "a2a_outbound_runs_remote_agent_id_a2a_remote_agents_id_fk" FOREIGN KEY ("remote_agent_id") REFERENCES "public"."a2a_remote_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_outbound_runs" ADD CONSTRAINT "a2a_outbound_runs_connection_id_a2a_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."a2a_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_outbound_runs" ADD CONSTRAINT "a2a_outbound_runs_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_outbound_runs" ADD CONSTRAINT "a2a_outbound_runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_outbound_runs" ADD CONSTRAINT "a2a_outbound_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_remote_agent_teams" ADD CONSTRAINT "a2a_remote_agent_teams_remote_agent_id_a2a_remote_agents_id_fk" FOREIGN KEY ("remote_agent_id") REFERENCES "public"."a2a_remote_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_remote_agent_teams" ADD CONSTRAINT "a2a_remote_agent_teams_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_remote_agent_users" ADD CONSTRAINT "a2a_remote_agent_users_remote_agent_id_a2a_remote_agents_id_fk" FOREIGN KEY ("remote_agent_id") REFERENCES "public"."a2a_remote_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_remote_agent_users" ADD CONSTRAINT "a2a_remote_agent_users_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_remote_agents" ADD CONSTRAINT "a2a_remote_agents_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_remote_agents" ADD CONSTRAINT "a2a_remote_agents_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "a2a_connections_remote_agent_id_uidx" ON "a2a_connections" USING btree ("remote_agent_id");--> statement-breakpoint
CREATE INDEX "a2a_outbound_runs_organization_id_idx" ON "a2a_outbound_runs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "a2a_outbound_runs_parent_agent_id_idx" ON "a2a_outbound_runs" USING btree ("parent_agent_id");--> statement-breakpoint
CREATE INDEX "a2a_outbound_runs_connection_task_idx" ON "a2a_outbound_runs" USING btree ("connection_id","remote_task_id");--> statement-breakpoint
CREATE INDEX "a2a_outbound_runs_remote_agent_started_at_idx" ON "a2a_outbound_runs" USING btree ("remote_agent_id","started_at");--> statement-breakpoint
CREATE INDEX "a2a_remote_agents_organization_id_idx" ON "a2a_remote_agents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "a2a_remote_agents_author_id_idx" ON "a2a_remote_agents" USING btree ("author_id");--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_delegate_to_a2a_connection_id_a2a_connections_id_fk" FOREIGN KEY ("delegate_to_a2a_connection_id") REFERENCES "public"."a2a_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tools_a2a_connection_uidx" ON "tools" USING btree ("delegate_to_a2a_connection_id") WHERE "tools"."delegate_to_a2a_connection_id" is not null;
