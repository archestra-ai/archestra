ALTER TABLE "conversations" ADD COLUMN "memory_extraction_status" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "memory_extracted_at" timestamp;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "memory_extraction_attempted_at" timestamp;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_extraction_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_injection_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_idle_delay_seconds" integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_extractor_max_tokens" integer DEFAULT 800 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_extractor_model" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_extractor_chat_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_injection_token_budget" integer DEFAULT 600 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_injection_top_k" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_tombstone_ttl_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_candidate_ttl_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_max_content_length" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_max_candidates_per_extraction" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_memory_extractor_chat_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("memory_extractor_chat_api_key_id") REFERENCES "chat_api_keys"("id") ON DELETE SET NULL;
