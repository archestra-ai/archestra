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
-- Prefer the model actually linked to the agent's key (api_key_models); if that
-- join is empty (stale links), fall back to a SAME-provider model only. Never
-- cross providers -- a cross-provider FK pins the agent to a model its key
-- cannot serve and disables the runtime fallback.
-- Best-effort: any error leaves model_id NULL, which falls through resolution.
-- The migration must never fail on backfill, only on schema changes above.
DO $$ BEGIN
  UPDATE "agents" a
  SET "model_id" = COALESCE(
    (
      SELECT m."id"
      FROM "models" m
      JOIN "api_key_models" akm ON akm."model_id" = m."id"
      WHERE m."model_id" = a."llm_model"
        AND akm."api_key_id" = a."llm_api_key_id"
      LIMIT 1
    ),
    (
      SELECT m."id"
      FROM "models" m
      WHERE m."model_id" = a."llm_model"
        AND m."provider" = (
          SELECT k."provider" FROM "chat_api_keys" k WHERE k."id" = a."llm_api_key_id"
        )
      LIMIT 1
    )
  )
  WHERE a."llm_model" IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'agents.model_id backfill skipped: %', SQLERRM;
END $$;--> statement-breakpoint
-- Backfill conversations.model_id from selected_model (+ selected_provider hint).
-- Best-effort: any error leaves model_id NULL.
DO $$ BEGIN
  UPDATE "conversations" c
  SET "model_id" = (
    SELECT m."id"
    FROM "models" m
    WHERE m."model_id" = c."selected_model"
    ORDER BY (m."provider" = c."selected_provider") DESC NULLS LAST
    LIMIT 1
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'conversations.model_id backfill skipped: %', SQLERRM;
END $$;--> statement-breakpoint
-- Backfill organization.default_model_id from default_llm_model (+ provider hint).
-- Best-effort: any error leaves default_model_id NULL.
DO $$ BEGIN
  UPDATE "organization" o
  SET "default_model_id" = (
    SELECT m."id"
    FROM "models" m
    WHERE m."model_id" = o."default_llm_model"
    ORDER BY (m."provider" = o."default_llm_provider") DESC NULLS LAST
    LIMIT 1
  )
  WHERE o."default_llm_model" IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'organization.default_model_id backfill skipped: %', SQLERRM;
END $$;
