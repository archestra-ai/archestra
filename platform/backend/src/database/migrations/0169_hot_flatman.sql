ALTER TABLE "kb_documents" DROP CONSTRAINT "kb_documents_knowledge_base_id_knowledge_bases_id_fk";
--> statement-breakpoint
ALTER TABLE "kb_documents" DROP CONSTRAINT "kb_documents_connector_id_knowledge_base_connectors_id_fk";
--> statement-breakpoint
DROP INDEX "kb_documents_kb_id_idx";--> statement-breakpoint
DROP INDEX "kb_documents_content_hash_idx";--> statement-breakpoint
DROP INDEX "kb_documents_source_idx";--> statement-breakpoint
ALTER TABLE "kb_documents" ALTER COLUMN "connector_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_connector_id_knowledge_base_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."knowledge_base_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_documents_source_idx" ON "kb_documents" USING btree ("connector_id","source_id");--> statement-breakpoint
-- Data migration: deduplicate documents with same connector_id + source_id, keep the newest
DELETE FROM kb_documents d1
USING kb_documents d2
WHERE d1.connector_id = d2.connector_id
  AND d1.source_id = d2.source_id
  AND d1.connector_id IS NOT NULL
  AND d1.source_id IS NOT NULL
  AND d1.created_at < d2.created_at;--> statement-breakpoint
-- Delete orphaned documents without a connector (cannot exist after this migration)
DELETE FROM kb_documents WHERE connector_id IS NULL;--> statement-breakpoint
ALTER TABLE "kb_documents" DROP COLUMN "knowledge_base_id";--> statement-breakpoint
ALTER TABLE "kb_documents" DROP COLUMN "source_type";