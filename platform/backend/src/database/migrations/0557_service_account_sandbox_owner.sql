-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The unique indexes cover only rows with the new service_account_id column set, which is empty when they are built, so no existing row can violate them and current writers never set it.
ALTER TABLE "files" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_sandboxes" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_sandboxes" ADD COLUMN "service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "files" VALIDATE CONSTRAINT "files_service_account_id_service_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "skill_sandboxes" ADD CONSTRAINT "skill_sandboxes_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "skill_sandboxes" VALIDATE CONSTRAINT "skill_sandboxes_service_account_id_service_accounts_id_fk";--> statement-breakpoint
CREATE INDEX "files_service_account_id_idx" ON "files" USING btree ("service_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "files_service_account_conversation_filename_uidx" ON "files" USING btree ("service_account_id","conversation_id","filename") WHERE "files"."service_account_id" IS NOT NULL AND "files"."project_id" IS NULL AND "files"."conversation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "files_service_account_app_filename_uidx" ON "files" USING btree ("service_account_id","app_id","filename") WHERE "files"."service_account_id" IS NOT NULL AND "files"."app_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "files_service_account_filename_orphan_uidx" ON "files" USING btree ("service_account_id","filename") WHERE "files"."service_account_id" IS NOT NULL AND "files"."project_id" IS NULL AND "files"."conversation_id" IS NULL AND "files"."app_id" IS NULL;--> statement-breakpoint
CREATE INDEX "skill_sandboxes_service_account_id_idx" ON "skill_sandboxes" USING btree ("service_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_sandboxes_service_account_default_uidx" ON "skill_sandboxes" USING btree ("organization_id","service_account_id","conversation_id") WHERE "skill_sandboxes"."is_default" AND "skill_sandboxes"."service_account_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_sandboxes_service_account_app_default_uidx" ON "skill_sandboxes" USING btree ("organization_id","service_account_id","app_id") WHERE "skill_sandboxes"."is_default" AND "skill_sandboxes"."service_account_id" IS NOT NULL AND "skill_sandboxes"."app_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_author_chk" CHECK (num_nonnulls("files"."user_id", "files"."service_account_id") = 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "files" VALIDATE CONSTRAINT "files_author_chk";--> statement-breakpoint
ALTER TABLE "skill_sandboxes" ADD CONSTRAINT "skill_sandboxes_owner_chk" CHECK (num_nonnulls("skill_sandboxes"."user_id", "skill_sandboxes"."service_account_id") = 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "skill_sandboxes" VALIDATE CONSTRAINT "skill_sandboxes_owner_chk";
