DROP INDEX "skills_org_name_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "skills_org_personal_name_idx" ON "skills" USING btree ("organization_id","author_id","name") WHERE "skills"."scope" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "skills_org_shared_name_idx" ON "skills" USING btree ("organization_id","name") WHERE "skills"."scope" in ('team', 'org');