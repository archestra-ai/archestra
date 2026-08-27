-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Every Runner table (runners, runner_labels, runner_sessions, user_credentials) is created empty in this same file, so all foreign keys, unique indexes and non-concurrent indexes validate against zero rows and take no meaningful lock; no older writer can produce a row in them. The agents.runner_id column is a nullable addition with no default — existing rows and older writers are unaffected, an agent without one simply has no long-running mode — and its foreign key validates against zero rows because no agent references a runner yet. ON DELETE cascade is deliberate: a session must not outlive the task it carries, the runner it launched from, or the user whose credentials it holds, and a label link must not outlive its runner. The set-null foreign keys are equally deliberate: a runner keeps its configuration when its environment or shared credential bag is removed, and a session keeps its record when its minted virtual key is revoked.
CREATE TABLE "runner_labels" (
	"runner_id" uuid NOT NULL,
	"label_key_id" uuid NOT NULL,
	"label_value_id" uuid NOT NULL,
	CONSTRAINT "runner_labels_runner_id_label_key_id_pk" PRIMARY KEY("runner_id","label_key_id")
);
--> statement-breakpoint
CREATE TABLE "runner_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"runner_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"deployment_name" text NOT NULL,
	"namespace" text NOT NULL,
	"secret_name" text,
	"virtual_api_key_id" uuid,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"image" text NOT NULL,
	"command" jsonb,
	"steer_mode" text DEFAULT 'pipe' NOT NULL,
	"privileged" boolean DEFAULT false NOT NULL,
	"resources" jsonb,
	"environment" jsonb,
	"credentials" jsonb,
	"secret_id" uuid,
	"environment_id" uuid,
	"ttl_hours" integer,
	"idle_timeout_minutes" integer,
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
ALTER TABLE "agents" ADD COLUMN "runner_id" uuid;--> statement-breakpoint
ALTER TABLE "runner_labels" ADD CONSTRAINT "runner_labels_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_labels" ADD CONSTRAINT "runner_labels_label_key_id_label_keys_id_fk" FOREIGN KEY ("label_key_id") REFERENCES "public"."label_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_labels" ADD CONSTRAINT "runner_labels_label_value_id_label_values_id_fk" FOREIGN KEY ("label_value_id") REFERENCES "public"."label_values"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_sessions" ADD CONSTRAINT "runner_sessions_task_id_a2a_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."a2a_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_sessions" ADD CONSTRAINT "runner_sessions_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_sessions" ADD CONSTRAINT "runner_sessions_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_sessions" ADD CONSTRAINT "runner_sessions_virtual_api_key_id_virtual_api_keys_id_fk" FOREIGN KEY ("virtual_api_key_id") REFERENCES "public"."virtual_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runner_labels_label_value_id_idx" ON "runner_labels" USING btree ("label_value_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_sessions_task_id_uidx" ON "runner_sessions" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_sessions_deployment_name_uidx" ON "runner_sessions" USING btree ("deployment_name");--> statement-breakpoint
CREATE INDEX "runner_sessions_runner_id_idx" ON "runner_sessions" USING btree ("runner_id");--> statement-breakpoint
CREATE INDEX "runner_sessions_organization_id_idx" ON "runner_sessions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "runners_organization_id_idx" ON "runners" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "runners_environment_id_idx" ON "runners" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runners_org_name_uidx" ON "runners" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "user_credentials_user_id_idx" ON "user_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_credentials_org_user_key_uidx" ON "user_credentials" USING btree ("organization_id","user_id","key");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;