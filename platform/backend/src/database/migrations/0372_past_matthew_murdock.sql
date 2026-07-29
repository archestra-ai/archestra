-- Foreign keys are declared inline rather than added by follow-up ALTERs. Every
-- table here is created empty in this same migration, so there are no rows for a
-- validating constraint to fail on; the inline form yields an identical schema
-- without the NOT VALID / VALIDATE dance the linter would otherwise require.
ALTER TYPE "public"."project_share_visibility" ADD VALUE 'user';--> statement-breakpoint
CREATE TABLE "agent_user" (
	"agent_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"level" text DEFAULT 'use' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_user_agent_id_user_id_pk" PRIMARY KEY("agent_id","user_id"),
	CONSTRAINT "agent_user_level_check" CHECK (
      "agent_user"."level" in ('use', 'write')),
	CONSTRAINT "agent_user_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "agent_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "model_user" (
	"model_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"level" text DEFAULT 'use' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "model_user_model_id_user_id_pk" PRIMARY KEY("model_id","user_id"),
	CONSTRAINT "model_user_level_check" CHECK (
      "model_user"."level" in ('use', 'write')),
	CONSTRAINT "model_user_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "model_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "project_share_user" (
	"share_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_share_user_share_id_user_id_pk" PRIMARY KEY("share_id","user_id"),
	CONSTRAINT "project_share_user_share_id_project_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."project_shares"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "project_share_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "skill_user" (
	"skill_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"level" text DEFAULT 'use' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_user_skill_id_user_id_pk" PRIMARY KEY("skill_id","user_id"),
	CONSTRAINT "skill_user_level_check" CHECK (
      "skill_user"."level" in ('use', 'write')),
	CONSTRAINT "skill_user_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "skill_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action
);
