-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Creates two new, empty tables (blob_providers, cost_exports). Their constraints and indexes are built on empty tables in the same transaction, so they validate nothing and block no existing writer.
CREATE TABLE "blob_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" varchar(256) NOT NULL,
	"type" varchar NOT NULL,
	"config" jsonb NOT NULL,
	"secret_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"blob_provider_id" uuid NOT NULL,
	"name" varchar(256) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"format" varchar NOT NULL,
	"schedule" varchar NOT NULL,
	"path_prefix" varchar(512) NOT NULL,
	"exported_through" timestamp NOT NULL,
	"running_until" timestamp,
	"last_run_at" timestamp,
	"last_run_status" varchar,
	"last_run_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_object_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blob_providers" ADD CONSTRAINT "blob_providers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_providers" ADD CONSTRAINT "blob_providers_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_exports" ADD CONSTRAINT "cost_exports_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_exports" ADD CONSTRAINT "cost_exports_blob_provider_id_blob_providers_id_fk" FOREIGN KEY ("blob_provider_id") REFERENCES "public"."blob_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blob_providers_organization_id_name_idx" ON "blob_providers" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "cost_exports_organization_id_idx" ON "cost_exports" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "cost_exports_blob_provider_id_idx" ON "cost_exports" USING btree ("blob_provider_id");