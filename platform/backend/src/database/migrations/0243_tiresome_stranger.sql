ALTER TABLE "agents" DROP COLUMN "llm_model";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "selected_model";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "selected_provider";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "default_llm_model";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "default_llm_provider";