-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Both FK constraints target project_memories, a table created empty in this same migration, so validation scans no existing rows and the add-validating-constraint rule does not apply. The index is on that same brand-new empty table, so CONCURRENTLY is unnecessary. ON DELETE cascade is intentional (a memory is meaningless without its parent project); ON DELETE set null keeps entries when their author is deleted.
CREATE TABLE "project_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"created_by_user_id" text,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_memories" ADD CONSTRAINT "project_memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memories" ADD CONSTRAINT "project_memories_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_memories_project_idx" ON "project_memories" USING btree ("project_id");