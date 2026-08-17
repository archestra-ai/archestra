import { pgTable, uuid } from "drizzle-orm/pg-core";
import knowledgeBasesTable from "./knowledge-base";
import knowledgeBaseConnectorsTable from "./knowledge-base-connector";

/**
 * The one internal `file_upload` connector backing a knowledge base.
 *
 * `kb_documents.connector_id` is NOT NULL, so indexed uploads need a connector.
 * One per knowledge base (rather than one per org) because connectors are
 * assigned to knowledge bases wholesale — a shared org-level connector would
 * expose its entire corpus through every knowledge base it was assigned to.
 *
 * The knowledge base id is the primary key, which is what makes first-index
 * racing safe: two concurrent requests contend on this row instead of both
 * creating a connector. These connectors are internal plumbing and are hidden
 * from the connector management UI.
 */
const kbUploadConnectorsTable = pgTable("kb_upload_connector", {
  knowledgeBaseId: uuid("knowledge_base_id")
    .primaryKey()
    .references(() => knowledgeBasesTable.id, { onDelete: "cascade" }),
  connectorId: uuid("connector_id")
    .notNull()
    .references(() => knowledgeBaseConnectorsTable.id, { onDelete: "cascade" }),
});

export default kbUploadConnectorsTable;
