-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=connection_setups was created in 0282 within this same branch and holds only ephemeral 15-minute render tickets; adding a NOT NULL DEFAULT column rewrites at most a handful of short-lived rows. The organization column is plain nullable jsonb.
ALTER TABLE "connection_setups" ADD COLUMN "proxy_auth" text DEFAULT 'provider-key' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "connection_default_provider_keys" jsonb;