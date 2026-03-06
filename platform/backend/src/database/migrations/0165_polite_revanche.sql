ALTER TABLE "kb_chunks" DROP CONSTRAINT "kb_chunks_knowledge_base_id_knowledge_bases_id_fk";
--> statement-breakpoint
DROP INDEX "kb_chunks_kb_id_idx";--> statement-breakpoint
ALTER TABLE "kb_chunks" DROP COLUMN "knowledge_base_id";