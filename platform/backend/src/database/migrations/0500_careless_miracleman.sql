-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The foreign keys and index target project_apps, created empty in this migration, so validation scans no existing rows. Deleting a project or an app intentionally drops its links.
CREATE TABLE "project_apps" (
	"project_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"linked_by" text,
	"linked_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_apps_project_id_app_id_pk" PRIMARY KEY("project_id","app_id")
);
--> statement-breakpoint
ALTER TABLE "project_apps" ADD CONSTRAINT "project_apps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_apps" ADD CONSTRAINT "project_apps_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_apps" ADD CONSTRAINT "project_apps_linked_by_user_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_apps_app_id_idx" ON "project_apps" USING btree ("app_id");