-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The three Runner tables (runners, runner_events, user_credentials) are created empty in this same file, so every foreign key, unique index and non-concurrent index validates against zero rows and takes no meaningful lock; no older writer can produce a row in them. The two agents columns are nullable additions with no default, so existing rows and older writers are unaffected — an agent without runner configuration simply cannot be started as a Runner — and their foreign key validates against zero rows because no agent has a runner secret yet. ON DELETE cascade is deliberate throughout: a runner must not outlive the agent it runs or the user whose credentials it holds, its event timeline must not outlive the runner, and a personal credential must not outlive its user or its secret. The set-null foreign keys are equally deliberate: a runner keeps its history when its environment or minted virtual key is removed, and removing a shared credential bag leaves the agent's other configuration intact.
CREATE TABLE "runner_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runner_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"message" text,
	"payload" jsonb,
	"actor_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"name" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"environment_id" uuid,
	"image" text NOT NULL,
	"command" jsonb,
	"task" text,
	"steer_mode" text DEFAULT 'pipe' NOT NULL,
	"privileged" boolean DEFAULT false NOT NULL,
	"resources" jsonb,
	"deployment_name" text,
	"namespace" text,
	"secret_name" text,
	"virtual_api_key_id" uuid,
	"ttl_hours" integer,
	"idle_timeout_minutes" integer,
	"last_activity_at" timestamp,
	"started_at" timestamp,
	"stopped_at" timestamp,
	"next_event_sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"secret_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runner_config" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runner_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "runner_events" ADD CONSTRAINT "runner_events_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_events" ADD CONSTRAINT "runner_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_virtual_api_key_id_virtual_api_keys_id_fk" FOREIGN KEY ("virtual_api_key_id") REFERENCES "public"."virtual_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runner_events_runner_id_idx" ON "runner_events" USING btree ("runner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_events_runner_id_sequence_uidx" ON "runner_events" USING btree ("runner_id","sequence");--> statement-breakpoint
CREATE INDEX "runners_organization_id_idx" ON "runners" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "runners_agent_id_idx" ON "runners" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "runners_created_by_user_id_idx" ON "runners" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "runners_state_idx" ON "runners" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "runners_deployment_name_uidx" ON "runners" USING btree ("deployment_name");--> statement-breakpoint
CREATE INDEX "user_credentials_user_id_idx" ON "user_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_credentials_org_user_key_uidx" ON "user_credentials" USING btree ("organization_id","user_id","key");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_runner_secret_id_secret_id_fk" FOREIGN KEY ("runner_secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;