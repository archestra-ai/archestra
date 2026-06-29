ALTER TABLE "models" ADD COLUMN "custom_price_per_million_input" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "custom_price_per_million_output" numeric(10, 2);--> statement-breakpoint

-- Data migration: Merge token_price custom overrides into models table

-- Step 1: For token_price entries that DO have a matching model row,
-- set custom prices when the token_price value differs from the models.dev computed price
-- (or when models.dev price is null). This preserves admin-set overrides.
UPDATE "models" m
SET
  "custom_price_per_million_input" = tp."price_per_million_input",
  "custom_price_per_million_output" = tp."price_per_million_output"
FROM "token_price" tp
WHERE tp."model" = m."model_id"
  AND tp."provider" = m."provider"
  AND (
    -- models.dev price is null (model has no synced pricing)
    m."prompt_price_per_token" IS NULL
    OR m."completion_price_per_token" IS NULL
    -- OR the token_price value differs from the models.dev computed value
    OR ROUND(CAST(m."prompt_price_per_token" AS numeric) * 1000000, 2) != CAST(tp."price_per_million_input" AS numeric)
    OR ROUND(CAST(m."completion_price_per_token" AS numeric) * 1000000, 2) != CAST(tp."price_per_million_output" AS numeric)
  );--> statement-breakpoint

-- Step 2: For token_price entries with NO matching model row,
-- insert stub model entries so custom pricing is preserved.
INSERT INTO "models" ("external_id", "provider", "model_id", "custom_price_per_million_input", "custom_price_per_million_output", "last_synced_at")
SELECT
  tp."provider" || '/' || tp."model",
  tp."provider",
  tp."model",
  tp."price_per_million_input",
  tp."price_per_million_output",
  NOW()
FROM "token_price" tp
WHERE NOT EXISTS (
  SELECT 1 FROM "models" m
  WHERE m."model_id" = tp."model" AND m."provider" = tp."provider"
)
ON CONFLICT ("provider", "model_id") DO NOTHING;
