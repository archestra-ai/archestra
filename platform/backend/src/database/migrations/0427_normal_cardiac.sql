ALTER TABLE "kb_chunks" ADD COLUMN "embedding_1408" vector(1408);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_chunks_embedding_1408_idx" ON "kb_chunks" USING hnsw ("embedding_1408" vector_cosine_ops);
