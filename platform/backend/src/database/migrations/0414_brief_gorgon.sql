-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=environment_resource_defaults is created empty in this same migration, so its validating foreign keys, its unique constraint, and its index are all applied before any writer can insert a row and cannot fail or block on existing data. ON DELETE CASCADE is intentional on both keys: deleting an organization removes its settings, and deleting an environment drops the rows that pointed new resources at it, so those resource kinds fall back to the default environment rather than naming an environment that no longer exists.
CREATE TABLE "environment_resource_defaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"resource" text NOT NULL,
	"environment_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "environment_resource_defaults_org_resource_unique" UNIQUE("organization_id","resource")
);
--> statement-breakpoint
ALTER TABLE "environment_resource_defaults" ADD CONSTRAINT "environment_resource_defaults_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_resource_defaults" ADD CONSTRAINT "environment_resource_defaults_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environment_resource_defaults_environment_id_idx" ON "environment_resource_defaults" USING btree ("environment_id");