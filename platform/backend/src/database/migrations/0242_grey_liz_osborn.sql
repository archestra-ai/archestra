ALTER TABLE "agents" ADD COLUMN "model_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "model_id" uuid;--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "default_model_id" uuid;--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "default_chat_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_model_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_default_model_id_models_id_fk" FOREIGN KEY ("default_model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_default_chat_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("default_chat_api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_default_model_id_models_id_fk" FOREIGN KEY ("default_model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill agents.model_id from the legacy llm_model text column.
-- The agents table has no provider column, so prefer the model whose provider
-- matches the agent's API key; fall back to any model with that id. Unmatched
-- agents keep model_id NULL and fall through the resolution chain.
UPDATE "agents" a
SET "model_id" = (
  SELECT m."id"
  FROM "models" m
  WHERE m."model_id" = a."llm_model"
  ORDER BY (
    m."provider" = (
      SELECT k."provider" FROM "chat_api_keys" k WHERE k."id" = a."llm_api_key_id"
    )
  ) DESC NULLS LAST
  LIMIT 1
)
WHERE a."llm_model" IS NOT NULL;--> statement-breakpoint
-- Backfill conversations.model_id from selected_model (+ selected_provider hint).
UPDATE "conversations" c
SET "model_id" = (
  SELECT m."id"
  FROM "models" m
  WHERE m."model_id" = c."selected_model"
  ORDER BY (m."provider" = c."selected_provider") DESC NULLS LAST
  LIMIT 1
);--> statement-breakpoint
-- Backfill organization.default_model_id from default_llm_model (+ provider hint).
UPDATE "organization" o
SET "default_model_id" = (
  SELECT m."id"
  FROM "models" m
  WHERE m."model_id" = o."default_llm_model"
  ORDER BY (m."provider" = o."default_llm_provider") DESC NULLS LAST
  LIMIT 1
)
WHERE o."default_llm_model" IS NOT NULL;