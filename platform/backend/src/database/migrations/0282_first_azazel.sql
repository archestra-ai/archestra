-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=projects, project_team, and project_knowledge_base are brand-new empty tables, so their FKs, unique index, and regular indexes cannot fail existing data or block existing writes; conversations.project_id and schedule_triggers.project_id are nullable new columns with no backfilled values, so their FKs cannot fail existing rows.
CREATE TABLE "project_knowledge_base" (
	"project_id" uuid NOT NULL,
	"knowledge_base_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_knowledge_base_project_id_knowledge_base_id_pk" PRIMARY KEY("project_id","knowledge_base_id")
);
--> statement-breakpoint
CREATE TABLE "project_team" (
	"project_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_team_project_id_team_id_pk" PRIMARY KEY("project_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"author_id" text,
	"scope" text DEFAULT 'personal' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"instructions" text,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "schedule_triggers" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "project_knowledge_base" ADD CONSTRAINT "project_knowledge_base_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_knowledge_base" ADD CONSTRAINT "project_knowledge_base_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_team" ADD CONSTRAINT "project_team_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_team" ADD CONSTRAINT "project_team_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_knowledge_base_project_idx" ON "project_knowledge_base" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_knowledge_base_kb_idx" ON "project_knowledge_base" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE INDEX "projects_organization_id_idx" ON "projects" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "projects_author_id_idx" ON "projects" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "projects_scope_idx" ON "projects" USING btree ("scope");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_personal_name_idx" ON "projects" USING btree ("organization_id","author_id","name");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_triggers" ADD CONSTRAINT "schedule_triggers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_triggers_project_id_idx" ON "schedule_triggers" USING btree ("project_id");
