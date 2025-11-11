ALTER TABLE "chat_settings" ADD COLUMN "provider" text DEFAULT 'anthropic' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_settings" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "chat_settings" ADD COLUMN "openai_api_key_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_settings" ADD CONSTRAINT "chat_settings_openai_api_key_secret_id_secret_id_fk" FOREIGN KEY ("openai_api_key_secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;