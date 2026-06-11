-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=skill_sandbox_folders is a brand-new empty table (its FK + unique index cannot fail existing rows) and skill_sandbox_files.folder_id is a new all-NULL column, so its FK validates trivially; user_id ON DELETE CASCADE mirrors the existing skill_sandboxes.user_id FK.
CREATE TABLE "skill_sandbox_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_sandbox_files" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_sandbox_files" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "skill_sandbox_folders" ADD CONSTRAINT "skill_sandbox_folders_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_sandbox_folders_user_name_uidx" ON "skill_sandbox_folders" USING btree ("user_id","name");--> statement-breakpoint
ALTER TABLE "skill_sandbox_files" ADD CONSTRAINT "skill_sandbox_files_folder_id_skill_sandbox_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."skill_sandbox_folders"("id") ON DELETE set null ON UPDATE no action;