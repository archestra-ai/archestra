ALTER TABLE "identity_provider" DROP CONSTRAINT "identity_provider_provider_id_unique";--> statement-breakpoint
ALTER TABLE "organization_role" DROP CONSTRAINT "organization_role_organization_id_role_unique";--> statement-breakpoint
ALTER TABLE "team_external_group" DROP CONSTRAINT "team_external_group_team_group_unique";--> statement-breakpoint
ALTER TABLE "team_token" DROP CONSTRAINT "team_token_organization_id_team_id_unique";--> statement-breakpoint
ALTER TABLE "user_token" DROP CONSTRAINT "user_token_organization_id_user_id_unique";--> statement-breakpoint
ALTER TABLE "identity_provider" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "invitation" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "organization_role" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "team_external_group" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "team_token" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "user_token" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_provider_provider_id_uidx" ON "identity_provider" USING btree ("provider_id") WHERE "identity_provider"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_role_org_role_uidx" ON "organization_role" USING btree ("organization_id","role") WHERE "organization_role"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "team_external_group_team_group_unique" ON "team_external_group" USING btree ("team_id","group_identifier") WHERE "team_external_group"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "team_token_org_team_uidx" ON "team_token" USING btree ("organization_id","team_id") WHERE "team_token"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_token_org_user_uidx" ON "user_token" USING btree ("organization_id","user_id") WHERE "user_token"."deleted_at" IS NULL;