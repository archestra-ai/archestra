-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Both FK constraints and the index target project_pins, a brand-new empty table created in this same migration. Validation scans no existing rows and the add-validating-constraint / create-index-without-concurrently rules do not apply here. ON DELETE cascade is intentional — pin rows are meaningless without their parent user or project.
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