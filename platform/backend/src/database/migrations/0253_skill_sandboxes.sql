CREATE TABLE "skill_sandbox_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"path" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_sandbox_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"command" text NOT NULL,
	"cwd" text,
	"stdout" text DEFAULT '' NOT NULL,
	"stderr" text DEFAULT '' NOT NULL,
	"exit_code" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_sandbox_skills" (
	"sandbox_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	CONSTRAINT "skill_sandbox_skills_sandbox_id_skill_id_pk" PRIMARY KEY("sandbox_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "skill_sandboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid,
	"agent_id" uuid,
	"base_image" text NOT NULL,
	"primary_skill_id" uuid,
	"default_cwd" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_sandbox_artifacts" ADD CONSTRAINT "skill_sandbox_artifacts_sandbox_id_skill_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."skill_sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandbox_commands" ADD CONSTRAINT "skill_sandbox_commands_sandbox_id_skill_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."skill_sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandbox_skills" ADD CONSTRAINT "skill_sandbox_skills_sandbox_id_skill_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."skill_sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandbox_skills" ADD CONSTRAINT "skill_sandbox_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandboxes" ADD CONSTRAINT "skill_sandboxes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandboxes" ADD CONSTRAINT "skill_sandboxes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandboxes" ADD CONSTRAINT "skill_sandboxes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sandboxes" ADD CONSTRAINT "skill_sandboxes_primary_skill_id_skills_id_fk" FOREIGN KEY ("primary_skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_sandbox_artifacts_sandbox_id_idx" ON "skill_sandbox_artifacts" USING btree ("sandbox_id");--> statement-breakpoint
CREATE INDEX "skill_sandbox_commands_sandbox_id_idx" ON "skill_sandbox_commands" USING btree ("sandbox_id");--> statement-breakpoint
CREATE INDEX "skill_sandbox_commands_sandbox_created_idx" ON "skill_sandbox_commands" USING btree ("sandbox_id","created_at");--> statement-breakpoint
CREATE INDEX "skill_sandboxes_organization_id_idx" ON "skill_sandboxes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "skill_sandboxes_user_id_idx" ON "skill_sandboxes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "skill_sandboxes_conversation_id_idx" ON "skill_sandboxes" USING btree ("conversation_id");
