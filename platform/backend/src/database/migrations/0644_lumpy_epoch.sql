-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Relaxes the one-system-key-per-provider index to one per provider and site. Existing rows already satisfy the new index (the old one allowed at most one per provider), and older writers only ever create siteless keys, which the new index still keeps unique per provider.
CREATE TABLE "sites" (
	"name" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"internal_url" text,
	"version" text NOT NULL,
	"capabilities" jsonb DEFAULT '{"keylessProviders":[]}'::jsonb NOT NULL,
	"draining" boolean DEFAULT false NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "chat_api_keys_system_unique";--> statement-breakpoint
ALTER TABLE "chat_api_keys" ADD COLUMN "site_name" text;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_api_keys_system_site_unique" ON "chat_api_keys" USING btree ("provider",coalesce("site_name", '')) WHERE "chat_api_keys"."is_system" = true;