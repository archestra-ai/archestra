-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=team_external_group is a small configuration table. The new foreign key covers identity_provider_id, a column added empty in this migration, so validation scans only NULLs. The replacement unique constraint is NULLS NOT DISTINCT on (team, provider, group): every existing row and every row an older release writes has a NULL provider, so it enforces exactly the dropped (team, group) guarantee for them and cannot fail existing data. ON DELETE CASCADE intentionally removes a provider's group mappings with the provider.
ALTER TABLE "team_external_group" DROP CONSTRAINT "team_external_group_team_group_unique";--> statement-breakpoint
ALTER TABLE "limits" ADD COLUMN "team_managed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_external_group" ADD COLUMN "identity_provider_id" text;--> statement-breakpoint
ALTER TABLE "team_external_group" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_member" ADD COLUMN "role_synced_from_sso" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_external_group" ADD CONSTRAINT "team_external_group_identity_provider_id_identity_provider_id_fk" FOREIGN KEY ("identity_provider_id") REFERENCES "public"."identity_provider"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_external_group" ADD CONSTRAINT "team_external_group_team_provider_group_unique" UNIQUE NULLS NOT DISTINCT("team_id","identity_provider_id","group_identifier");