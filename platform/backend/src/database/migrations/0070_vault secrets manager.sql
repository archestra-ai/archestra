ALTER TABLE "secret" ADD COLUMN "is_vault" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "use_in_chat";