CREATE TABLE "skill_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"encoding" text DEFAULT 'utf8' NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"author_id" text,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"license" text,
	"compatibility" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_type" text DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"source_commit" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_files_skill_id_idx" ON "skill_files" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_files_skill_path_idx" ON "skill_files" USING btree ("skill_id","path");--> statement-breakpoint
CREATE INDEX "skills_organization_id_idx" ON "skills" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_org_name_idx" ON "skills" USING btree ("organization_id","name");--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "skill_tools_enabled" boolean DEFAULT false NOT NULL;