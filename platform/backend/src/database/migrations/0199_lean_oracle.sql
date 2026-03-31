ALTER TABLE "kb_chunks" ADD COLUMN "embedding_3072" vector(3072);--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "is_embedding" boolean DEFAULT false NOT NULL;