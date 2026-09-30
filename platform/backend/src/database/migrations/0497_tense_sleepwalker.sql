-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Channel bindings and message receipts become scoped to a bot; older code inserts rows without a bot id and conflicts on the dropped unique index, so this is a contract migration that must not overlap with old pods.
CREATE TABLE "chatops_bots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider" varchar(32) NOT NULL,
	"name" varchar(256) NOT NULL,
	"secret_id" uuid,
	"external_app_id" varchar(64),
	"external_workspace_id" varchar(64),
	"external_bot_user_id" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chatops_bots" ADD CONSTRAINT "chatops_bots_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chatops_bots_organization_provider_idx" ON "chatops_bots" USING btree ("organization_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "chatops_bots_identity_idx" ON "chatops_bots" USING btree ("organization_id","provider","external_workspace_id","external_bot_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chatops_bots_single_bot_provider_idx" ON "chatops_bots" USING btree ("organization_id","provider") WHERE "chatops_bots"."provider" <> 'slack';--> statement-breakpoint
-- Data migration: every provider that is already configured (or already has
-- channel bindings) becomes bot #1 of that provider. The existing singleton
-- credential secret is reused as-is, so nothing has to be re-entered and the
-- first Slack App keeps its webhook URLs, tokens and mode.
INSERT INTO "chatops_bots" ("organization_id", "provider", "name", "secret_id")
SELECT
	org."id",
	configured."provider",
	COALESCE(NULLIF(org."app_name", ''), 'Archestra'),
	secret_row."id"
FROM (
	SELECT "id", "app_name" FROM "organization" ORDER BY "created_at" LIMIT 1
) AS org
CROSS JOIN (VALUES
	('slack', 'chatops-slack'),
	('ms-teams', 'chatops-ms-teams'),
	('telegram', 'chatops-telegram')
) AS configured("provider", "secret_name")
INNER JOIN LATERAL (
	SELECT "id" FROM "secret"
	WHERE "name" = configured."secret_name"
	ORDER BY "created_at"
	LIMIT 1
) AS secret_row ON true;--> statement-breakpoint
-- Bindings that outlived their provider configuration still need an owner bot.
INSERT INTO "chatops_bots" ("organization_id", "provider", "name")
SELECT DISTINCT
	binding."organization_id",
	binding."provider",
	COALESCE(NULLIF(org."app_name", ''), 'Archestra')
FROM "chatops_channel_binding" AS binding
LEFT JOIN "organization" AS org ON org."id" = binding."organization_id"
WHERE NOT EXISTS (
	SELECT 1 FROM "chatops_bots" AS existing_bot
	WHERE existing_bot."organization_id" = binding."organization_id"
		AND existing_bot."provider" = binding."provider"
);--> statement-breakpoint
ALTER TABLE "chatops_channel_binding" ADD COLUMN "bot_id" uuid;--> statement-breakpoint
-- Binding ids stay untouched, so agent assignments, completion targets and
-- pending delayed output keep resolving to the same rows.
UPDATE "chatops_channel_binding" AS binding
SET "bot_id" = (
	SELECT bot."id" FROM "chatops_bots" AS bot
	WHERE bot."organization_id" = binding."organization_id"
		AND bot."provider" = binding."provider"
	ORDER BY bot."created_at"
	LIMIT 1
);--> statement-breakpoint
ALTER TABLE "chatops_channel_binding" ALTER COLUMN "bot_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chatops_channel_binding" ADD CONSTRAINT "chatops_channel_binding_bot_id_chatops_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."chatops_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP INDEX "chatops_channel_binding_provider_channel_workspace_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "chatops_channel_binding_bot_channel_workspace_idx" ON "chatops_channel_binding" USING btree ("bot_id","channel_id","workspace_id");--> statement-breakpoint
CREATE INDEX "chatops_channel_binding_provider_idx" ON "chatops_channel_binding" USING btree ("provider");--> statement-breakpoint
ALTER TABLE "chatops_processed_message" DROP CONSTRAINT "chatops_processed_message_message_id_unique";--> statement-breakpoint
ALTER TABLE "chatops_processed_message" ADD COLUMN "bot_id" uuid;--> statement-breakpoint
-- Receipts carry no provider, so hand the retained ones to the first Slack bot:
-- a redelivery of a message processed just before the upgrade is still
-- recognised as a duplicate instead of being answered twice.
UPDATE "chatops_processed_message"
SET "bot_id" = (
	SELECT "id" FROM "chatops_bots"
	WHERE "provider" = 'slack'
	ORDER BY "created_at"
	LIMIT 1
);--> statement-breakpoint
ALTER TABLE "chatops_processed_message" ADD CONSTRAINT "chatops_processed_message_bot_id_chatops_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."chatops_bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatops_processed_message" ADD CONSTRAINT "chatops_processed_message_bot_message_uq" UNIQUE NULLS NOT DISTINCT("bot_id","message_id");
