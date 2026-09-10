-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=resource_permission_policies is created empty in this migration, so the validating foreign key has no existing rows to scan. Cascading organization deletion removes only that organization's permission documents, which must not outlive it. No existing resource or interaction rows are rewritten.
CREATE TABLE "resource_permission_policies" (
	"organization_id" text NOT NULL,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "resource_permission_policies_organization_id_resource_scope_pk" PRIMARY KEY("organization_id","resource","scope")
);
--> statement-breakpoint
ALTER TABLE "resource_permission_policies" ADD CONSTRAINT "resource_permission_policies_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
