-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=agent_runs, agent_execution_inputs, and user_credentials are introduced empty in this migration, so their foreign keys and indexes validate without locking populated tables. The Agent and MCP execution-id columns are nullable with no defaults, so existing rows and older writers remain valid; ON DELETE behavior deliberately removes execution/input/credential rows with their owning task, Agent, or user and preserves execution history when a short-lived virtual key is revoked.
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"title" text DEFAULT 'Execution' NOT NULL,
	"deployment_name" text NOT NULL,
	"backend" text NOT NULL,
	"runtime_scope" text NOT NULL,
	"virtual_api_key_id" uuid,
	"chatops_binding_id" uuid,
	"chatops_thread_id" text,
	"completion_notification_claimed_at" timestamp,
	"completion_notified_at" timestamp,
	"logs" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "user_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"key" text NOT NULL,
	"secret_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "background_execution" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "background_execution_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_task_id_a2a_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."a2a_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_virtual_api_key_id_virtual_api_keys_id_fk" FOREIGN KEY ("virtual_api_key_id") REFERENCES "public"."virtual_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_task_id_uidx" ON "agent_runs" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_deployment_name_uidx" ON "agent_runs" USING btree ("deployment_name");--> statement-breakpoint
CREATE INDEX "agent_runs_agent_id_idx" ON "agent_runs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_runs_organization_id_idx" ON "agent_runs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "agent_runs_actor_user_id_idx" ON "agent_runs" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "user_credentials_user_id_idx" ON "user_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_credentials_agent_id_idx" ON "user_credentials" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_credentials_org_user_agent_key_uidx" ON "user_credentials" USING btree ("organization_id","user_id","agent_id","key");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_background_execution_secret_id_secret_id_fk" FOREIGN KEY ("background_execution_secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD COLUMN "execution_id" varchar;
--> statement-breakpoint
CREATE TABLE "agent_execution_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"uploaded_by_user_id" text NOT NULL,
	"original_name" text NOT NULL,
	"runtime_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_size" integer NOT NULL,
	"file_data" "bytea" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_execution_inputs" ADD CONSTRAINT "agent_execution_inputs_task_id_a2a_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."a2a_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_execution_inputs" ADD CONSTRAINT "agent_execution_inputs_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_execution_inputs_task_id_idx" ON "agent_execution_inputs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "agent_execution_inputs_organization_id_idx" ON "agent_execution_inputs" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_execution_inputs_task_path_uidx" ON "agent_execution_inputs" USING btree ("task_id","runtime_path");
