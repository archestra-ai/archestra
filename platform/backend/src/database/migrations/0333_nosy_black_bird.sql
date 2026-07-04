ALTER TABLE "kb_chunks" ADD COLUMN "embedding_1024" vector(1024);--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN "embedding_384" vector(384);--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "default_parameters" jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_chunks_embedding_1024_idx" ON "kb_chunks" USING hnsw ("embedding_1024" vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_chunks_embedding_384_idx" ON "kb_chunks" USING hnsw ("embedding_384" vector_cosine_ops);
