DO $$ BEGIN
 CREATE TYPE "public"."llm_provider" AS ENUM('anthropic', 'openai');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "optimization_rules" ADD COLUMN "provider" "llm_provider" NOT NULL DEFAULT 'openai';
