-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=kb_connector_document_counts is created empty in this same migration, so its validating FK cannot fail existing rows, and the cascade only removes a deleted connector's count row, which is the intended cleanup. Nothing is backfilled: a connector without a row is counted by its next sync or by the first read that needs it. Locks: SHARE ROW EXCLUSIVE on knowledge_base_connectors for the FK, held for a short catalog-only transaction.
CREATE TABLE "kb_connector_document_counts" (
	"connector_id" uuid PRIMARY KEY NOT NULL,
	"document_count" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_connector_document_counts" ADD CONSTRAINT "kb_connector_document_counts_connector_id_knowledge_base_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."knowledge_base_connectors"("id") ON DELETE cascade ON UPDATE no action;