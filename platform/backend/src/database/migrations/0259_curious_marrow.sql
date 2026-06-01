CREATE TABLE "environment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"namespace" text,
	"restricted" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "environment_org_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_environment_name" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_environment_namespace" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_environment_description" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_environment_restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environment_org_idx" ON "environment" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD CONSTRAINT "internal_mcp_catalog_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "internal_mcp_catalog_environment_id_idx" ON "internal_mcp_catalog" USING btree ("environment_id");