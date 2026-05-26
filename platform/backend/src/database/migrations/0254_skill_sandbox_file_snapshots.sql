CREATE TABLE "skill_sandbox_file_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"skill_name" text NOT NULL,
	"path" text NOT NULL,
	"encoding" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_sandbox_file_snapshots" ADD CONSTRAINT "skill_sandbox_file_snapshots_sandbox_id_skill_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."skill_sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_sandbox_file_snapshots_sandbox_id_idx" ON "skill_sandbox_file_snapshots" USING btree ("sandbox_id");
