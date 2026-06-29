ALTER TABLE "kb_chunks" ADD COLUMN "embedding_3072" vector(3072);--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "embedding_dimensions" integer;--> statement-breakpoint

UPDATE "models"
SET "embedding_dimensions" = CASE
  WHEN lower("model_id") = 'text-embedding-3-small' THEN 1536
  WHEN lower("model_id") = 'text-embedding-3-large' THEN 1536
  WHEN lower("model_id") = 'nomic-embed-text' THEN 768
  WHEN lower("model_id") = 'gemini-embedding-001' THEN 3072
  ELSE "embedding_dimensions"
END
WHERE "embedding_dimensions" IS NULL;--> statement-breakpoint

UPDATE "models" AS "m"
SET "embedding_dimensions" = COALESCE(
  "m"."embedding_dimensions",
  "o"."embedding_dimensions"
)
FROM "organization" AS "o"
JOIN "chat_api_keys" AS "cak"
  ON "cak"."id" = "o"."embedding_chat_api_key_id"
WHERE
  "o"."embedding_model" IS NOT NULL
  AND "o"."embedding_model" = "m"."model_id"
  AND "cak"."provider" = "m"."provider";--> statement-breakpoint
