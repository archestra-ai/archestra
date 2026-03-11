ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "default_llm_model" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "default_llm_provider" text;