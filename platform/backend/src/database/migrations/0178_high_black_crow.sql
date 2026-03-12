ALTER TABLE "kb_chunks" ADD COLUMN "embedding_768" vector(768);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_chunks_embedding_768_idx" ON "kb_chunks" USING hnsw ("embedding_768" vector_cosine_ops);--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "embedding_dimensions" integer;