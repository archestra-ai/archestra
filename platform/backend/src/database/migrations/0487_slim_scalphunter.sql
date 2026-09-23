-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The foreign key and indexes target openappa_external_consults, created empty in this migration, so validation scans no existing rows. Deleting an organization intentionally removes its recorded consults.
CREATE TABLE "openappa_external_consults" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"session_id" text,
	"caller_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" bigint NOT NULL,
	"role" text NOT NULL,
	"external_name" text NOT NULL,
	"backend" text NOT NULL,
	"request" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"answer" jsonb,
	"raw_response" "bytea",
	"http_status" integer,
	"diagnostics" "bytea",
	"diagnostics_truncated" boolean DEFAULT false NOT NULL,
	"root" text NOT NULL,
	"trajectory" text NOT NULL,
	"call_id" text,
	"offer_id" text,
	"call_digest" text
);
--> statement-breakpoint
ALTER TABLE "openappa_external_consults" ADD CONSTRAINT "openappa_external_consults_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "openappa_external_consults_org_created_idx" ON "openappa_external_consults" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "openappa_external_consults_created_idx" ON "openappa_external_consults" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "openappa_external_consults_root_idx" ON "openappa_external_consults" USING btree ("root");