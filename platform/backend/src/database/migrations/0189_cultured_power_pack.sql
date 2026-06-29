ALTER TABLE "kb_chunks" ADD COLUMN "metadata_suffix_semantic" text;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN "metadata_suffix_keyword" text;--> statement-breakpoint
-- Update search_vector generated column to include keyword metadata suffix
ALTER TABLE "kb_chunks" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', content || ' ' || COALESCE(metadata_suffix_keyword, ''))) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_chunks_search_vector_idx" ON "kb_chunks" USING gin ("search_vector");
