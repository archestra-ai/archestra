-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The foreign key and unique index target a table created empty in this migration, so validation scans no existing rows. ON DELETE CASCADE intentionally removes a Teams user sign-in when its stored token secret is deleted. The new table is additive and ignored by older releases.
CREATE TABLE "chatops_ms_teams_user_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"aad_object_id" text NOT NULL,
	"secret_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chatops_ms_teams_user_connections" ADD CONSTRAINT "chatops_ms_teams_user_connections_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chatops_ms_teams_user_connections_tenant_user_uidx" ON "chatops_ms_teams_user_connections" USING btree ("tenant_id","aad_object_id");