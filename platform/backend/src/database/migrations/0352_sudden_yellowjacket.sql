ALTER TABLE "interactions" ADD COLUMN "billing_mode" varchar DEFAULT 'metered' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_keys" ADD COLUMN "billing_mode" text DEFAULT 'metered' NOT NULL;