ALTER TABLE "prompts" ADD COLUMN "history" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DELETE FROM "prompts" WHERE is_active = false;--> statement-breakpoint
ALTER TABLE "prompts" DROP COLUMN "parent_prompt_id";--> statement-breakpoint
ALTER TABLE "prompts" DROP COLUMN "is_active";
