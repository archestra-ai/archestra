-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Both FK constraints target project_pins, a table created empty in this same migration, so validation scans no existing rows and the add-validating-constraint rule does not apply. The index is on that same brand-new empty table, so CONCURRENTLY is unnecessary. ON DELETE cascade is intentional (a pin is meaningless without its parent user/project).
CREATE TABLE "project_pins" (
	"user_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"pinned_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_pins_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "project_pins" ADD CONSTRAINT "project_pins_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_pins" ADD CONSTRAINT "project_pins_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_pins_project_id_idx" ON "project_pins" USING btree ("project_id");