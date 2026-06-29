ALTER TABLE "virtual_api_key_model_router_api_key" RENAME TO "virtual_api_key_provider_api_key";--> statement-breakpoint
ALTER TABLE "virtual_api_key_provider_api_key" RENAME COLUMN "chat_api_key_id" TO "provider_api_key_id";--> statement-breakpoint
ALTER TABLE "organization" RENAME COLUMN "mcp_oauth_access_token_lifetime_seconds" TO "oauth_access_token_lifetime_seconds";--> statement-breakpoint
INSERT INTO "virtual_api_key_provider_api_key" ("virtual_api_key_id", "provider", "provider_api_key_id", "created_at")
SELECT
  "virtual_api_keys"."id",
  "chat_api_keys"."provider",
  "virtual_api_keys"."chat_api_key_id",
  "virtual_api_keys"."created_at"
FROM "virtual_api_keys"
INNER JOIN "chat_api_keys" ON "chat_api_keys"."id" = "virtual_api_keys"."chat_api_key_id"
WHERE "virtual_api_keys"."chat_api_key_id" IS NOT NULL
ON CONFLICT ("virtual_api_key_id", "provider") DO NOTHING;--> statement-breakpoint
UPDATE "oauth_client"
SET "metadata" = (
  "metadata" - 'chatApiKeyId' - 'modelRouterProviderApiKeys'
  || jsonb_build_object(
    'providerApiKeys',
    (
      SELECT COALESCE(jsonb_agg(DISTINCT "provider_key_mapping"), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'provider', "chat_api_keys"."provider",
          'providerApiKeyId', "chat_api_keys"."id"::text
        ) AS "provider_key_mapping"
        FROM "chat_api_keys"
        WHERE "chat_api_keys"."id"::text = "oauth_client"."metadata"->>'chatApiKeyId'
        UNION
        SELECT jsonb_build_object(
          'provider', "model_router_provider_key_mapping"->>'provider',
          'providerApiKeyId', "model_router_provider_key_mapping"->>'chatApiKeyId'
        ) AS "provider_key_mapping"
        FROM jsonb_array_elements(
          COALESCE("oauth_client"."metadata"->'modelRouterProviderApiKeys', '[]'::jsonb)
        ) AS "model_router_provider_key_mapping"
        WHERE "model_router_provider_key_mapping" ? 'provider'
          AND "model_router_provider_key_mapping" ? 'chatApiKeyId'
      ) AS "provider_key_mappings"
    )
  )
)
WHERE "metadata"->>'type' = 'llm_oauth_client';--> statement-breakpoint
ALTER TABLE "virtual_api_key_provider_api_key" DROP CONSTRAINT "virtual_api_key_model_router_api_key_virtual_api_key_id_virtual_api_keys_id_fk";
--> statement-breakpoint
ALTER TABLE "virtual_api_key_provider_api_key" DROP CONSTRAINT "virtual_api_key_model_router_api_key_chat_api_key_id_chat_api_keys_id_fk";
--> statement-breakpoint
ALTER TABLE "virtual_api_keys" DROP CONSTRAINT "virtual_api_keys_chat_api_key_id_chat_api_keys_id_fk";
--> statement-breakpoint
DROP INDEX "idx_virtual_api_key_model_router_api_key_id";--> statement-breakpoint
DROP INDEX "idx_virtual_api_key_chat_api_key_id";--> statement-breakpoint
ALTER TABLE "virtual_api_key_provider_api_key" DROP CONSTRAINT "virtual_api_key_model_router_api_key_virtual_api_key_id_provider_pk";--> statement-breakpoint
ALTER TABLE "virtual_api_key_provider_api_key" ADD CONSTRAINT "virtual_api_key_provider_api_key_virtual_api_key_id_provider_pk" PRIMARY KEY("virtual_api_key_id","provider");--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "auth_method" varchar;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "authenticated_app_id" text;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "authenticated_app_name" varchar;--> statement-breakpoint
ALTER TABLE "virtual_api_key_provider_api_key" ADD CONSTRAINT "virtual_api_key_provider_api_key_virtual_api_key_id_virtual_api_keys_id_fk" FOREIGN KEY ("virtual_api_key_id") REFERENCES "public"."virtual_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_api_key_provider_api_key" ADD CONSTRAINT "virtual_api_key_provider_api_key_provider_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("provider_api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_virtual_api_key_provider_api_key_id" ON "virtual_api_key_provider_api_key" USING btree ("provider_api_key_id");--> statement-breakpoint
ALTER TABLE "virtual_api_keys" DROP COLUMN "chat_api_key_id";
