CREATE TABLE "chat_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"secret_id" uuid,
	"is_organization_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_chat_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"chat_api_key_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "profile_chat_api_keys_agent_key_unique" UNIQUE("agent_id","chat_api_key_id")
);
--> statement-breakpoint
ALTER TABLE "chat_api_keys" ADD CONSTRAINT "chat_api_keys_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_chat_api_keys" ADD CONSTRAINT "profile_chat_api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_chat_api_keys" ADD CONSTRAINT "profile_chat_api_keys_chat_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("chat_api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_api_keys_organization_id_idx" ON "chat_api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "chat_api_keys_org_provider_idx" ON "chat_api_keys" USING btree ("organization_id","provider");--> statement-breakpoint
-- Data migration: Migrate existing Anthropic API keys from chat_settings to chat_api_keys
INSERT INTO "chat_api_keys" ("organization_id", "name", "provider", "secret_id", "is_organization_default", "created_at", "updated_at")
SELECT 
  "organization_id",
  'Default Anthropic Key',
  'anthropic',
  "anthropic_api_key_secret_id",
  true,
  "created_at",
  "updated_at"
FROM "chat_settings"
WHERE "anthropic_api_key_secret_id" IS NOT NULL;