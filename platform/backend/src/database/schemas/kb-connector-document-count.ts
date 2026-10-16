import { bigint, pgTable, uuid } from "drizzle-orm/pg-core";
import knowledgeBaseConnectorsTable from "./knowledge-base-connector";

/**
 * Stored number of `kb_documents` rows per connector.
 *
 * Maintained entirely by triggers on `kb_documents` (see the migration that
 * creates this table): statement-level INSERT/DELETE/TRUNCATE triggers with
 * transition tables, plus a row-level trigger for the rare UPDATE that moves a
 * document to another connector. Application code only reads it, so the
 * knowledge base listing does not have to count every document on each
 * request.
 *
 * Kept off `knowledge_base_connectors` so connector rows (rewritten by every
 * sync checkpoint) do not also churn on each document write, and so the
 * connector API schemas stay unchanged. A connector with no row has 0
 * documents.
 */
const kbConnectorDocumentCountsTable = pgTable("kb_connector_document_counts", {
  connectorId: uuid("connector_id")
    .primaryKey()
    .references(() => knowledgeBaseConnectorsTable.id, { onDelete: "cascade" }),
  documentCount: bigint("document_count", { mode: "number" })
    .notNull()
    .default(0),
});

export default kbConnectorDocumentCountsTable;
