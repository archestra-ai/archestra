import { bigint, pgTable, uuid } from "drizzle-orm/pg-core";
import knowledgeBaseConnectorsTable from "./knowledge-base-connector";

/**
 * Stored number of `kb_documents` rows per connector, so listings do not count
 * every document on each request.
 *
 * A connector has no row until it is first counted (the "not counted yet"
 * state). Rows are written when a sync run ends, after documents are deleted or
 * uploaded outside a sync, and lazily by the first read that finds no row.
 * Every write stores the connector's current total, never an increment, so a
 * repeated or out-of-order write cannot make the count drift: the next write
 * corrects it.
 *
 * Kept off `knowledge_base_connectors` so the connector API schemas and their
 * declarative reads stay unchanged.
 */
const kbConnectorDocumentCountsTable = pgTable("kb_connector_document_counts", {
  connectorId: uuid("connector_id")
    .primaryKey()
    .references(() => knowledgeBaseConnectorsTable.id, { onDelete: "cascade" }),
  documentCount: bigint("document_count", { mode: "number" }).notNull(),
});

export default kbConnectorDocumentCountsTable;
