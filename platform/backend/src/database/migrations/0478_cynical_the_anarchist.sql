ALTER TABLE "chat_api_keys" ADD COLUMN "models_last_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "first_catalog_synced_at" timestamp;--> statement-breakpoint
-- Existing keys establish a baseline even if their last catalog was empty.
UPDATE "chat_api_keys" SET "models_last_synced_at" = CURRENT_TIMESTAMP
WHERE "models_last_synced_at" IS NULL;--> statement-breakpoint
UPDATE "models" SET "first_catalog_synced_at" = CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "api_key_models" WHERE "model_id" = "models"."id");
