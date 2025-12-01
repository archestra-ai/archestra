-- Add provider column as nullable first
ALTER TABLE "token_price" ADD COLUMN "provider" text;--> statement-breakpoint

-- Infer provider from model name patterns
UPDATE "token_price"
SET "provider" = CASE
  WHEN LOWER("model") LIKE 'claude%' THEN 'anthropic'
  WHEN LOWER("model") LIKE 'gpt%' THEN 'openai'
  WHEN LOWER("model") LIKE 'o1%' THEN 'openai'
  WHEN LOWER("model") LIKE 'o3%' THEN 'openai'
  WHEN LOWER("model") LIKE 'gemini%' THEN 'gemini'
  ELSE 'openai'  -- Default to openai for unknown models
END
WHERE "provider" IS NULL;--> statement-breakpoint

-- Make the column NOT NULL now that all rows have values
ALTER TABLE "token_price" ALTER COLUMN "provider" SET NOT NULL;
