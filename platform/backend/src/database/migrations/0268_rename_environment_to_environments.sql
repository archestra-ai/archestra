ALTER TABLE "environment" RENAME TO "environments";--> statement-breakpoint
ALTER TABLE "environments" DROP CONSTRAINT "environment_org_name_unique";--> statement-breakpoint
ALTER TABLE "environments" DROP CONSTRAINT "environment_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" DROP CONSTRAINT "internal_mcp_catalog_environment_id_environment_id_fk";
--> statement-breakpoint
DROP INDEX "environment_org_idx";--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD CONSTRAINT "internal_mcp_catalog_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environments_org_idx" ON "environments" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_org_name_unique" UNIQUE("organization_id","name");