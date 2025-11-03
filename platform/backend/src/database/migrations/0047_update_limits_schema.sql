ALTER TABLE "limits" ADD COLUMN "current_usage_tokens_in" integer DEFAULT 0 NOT NULL;
ALTER TABLE "limits" ADD COLUMN "current_usage_tokens_out" integer DEFAULT 0 NOT NULL;
ALTER TABLE "limits" DROP COLUMN IF EXISTS "current_usage";