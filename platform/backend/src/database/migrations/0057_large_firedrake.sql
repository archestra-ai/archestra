-- Step 1: Convert model column from VARCHAR to JSONB array
-- Before: "gpt-4o" (varchar)
-- After: ["gpt-4o"] (jsonb array)
UPDATE "limits"
SET "model" = jsonb_build_array("model"::text)
WHERE "model" IS NOT NULL AND "model" != '' AND limit_type = 'token_cost';
--> statement-breakpoint
-- Change column type from varchar to jsonb
ALTER TABLE "limits" ALTER COLUMN "model" SET DATA TYPE jsonb USING "model"::jsonb;
--> statement-breakpoint
-- Step 2: Create limit_model_usage table for per-model usage tracking
CREATE TABLE "limit_model_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"limit_id" uuid NOT NULL,
	"model" varchar(255) NOT NULL,
	"current_usage_tokens_in" integer DEFAULT 0 NOT NULL,
	"current_usage_tokens_out" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "limit_model_usage" ADD CONSTRAINT "limit_model_usage_limit_id_limits_id_fk" FOREIGN KEY ("limit_id") REFERENCES "public"."limits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "limit_model_usage_limit_id_idx" ON "limit_model_usage" USING btree ("limit_id");--> statement-breakpoint
CREATE INDEX "limit_model_usage_limit_model_idx" ON "limit_model_usage" USING btree ("limit_id","model");--> statement-breakpoint
-- Add unique constraint to prevent duplicate (limit_id, model) pairs
ALTER TABLE "limit_model_usage" ADD CONSTRAINT "limit_model_usage_limit_id_model_unique" UNIQUE("limit_id", "model");