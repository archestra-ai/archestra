-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=the FOREIGN KEY is added on organization.ocr_chat_api_key_id, a column created NULL in this same file, so validation scans only the tiny organization table (one row per deployment) against chat_api_keys' primary key; both locks are momentary and no rows can fail the check.
ALTER TABLE "organization" ADD COLUMN "ocr_chat_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "ocr_model" text;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_ocr_chat_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("ocr_chat_api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE set null ON UPDATE no action;
