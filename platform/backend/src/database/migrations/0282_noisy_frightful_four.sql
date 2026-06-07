ALTER TABLE "skill_sandbox_files" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_sandbox_files" ADD COLUMN "storage_provider" text DEFAULT 'db' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_sandbox_files" ADD COLUMN "object_key" text;--> statement-breakpoint
ALTER TABLE "skill_sandbox_files" ADD CONSTRAINT "skill_sandbox_files_storage_payload_chk" CHECK ((
        ("skill_sandbox_files"."storage_provider" = 'db' AND "skill_sandbox_files"."data" IS NOT NULL AND "skill_sandbox_files"."object_key" IS NULL)
        OR ("skill_sandbox_files"."storage_provider" = 'filesystem' AND "skill_sandbox_files"."object_key" IS NOT NULL AND "skill_sandbox_files"."data" IS NULL)
      )) NOT VALID;--> statement-breakpoint
ALTER TABLE "skill_sandbox_files" VALIDATE CONSTRAINT "skill_sandbox_files_storage_payload_chk";