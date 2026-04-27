ALTER TABLE "memory_item" ADD COLUMN "scores" jsonb;--> statement-breakpoint
ALTER TABLE "memory_item" ADD COLUMN "classifications" jsonb;--> statement-breakpoint
ALTER TABLE "memory_item" ADD COLUMN "scorer_version" text;--> statement-breakpoint
ALTER TABLE "memory_item" ADD COLUMN "last_retrieved_at" timestamp;--> statement-breakpoint
ALTER TABLE "memory_item" ADD COLUMN "retrieval_count" integer DEFAULT 0 NOT NULL;