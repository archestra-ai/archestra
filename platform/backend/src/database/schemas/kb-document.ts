import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { EmbeddingStatus, KbDocumentMetadata } from "@/types/kb-document";
import knowledgeBaseConnectorsTable from "./knowledge-base-connector";

const kbDocumentsTable = pgTable(
  "kb_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    sourceId: text("source_id"),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => knowledgeBaseConnectorsTable.id, {
        onDelete: "cascade",
      }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    sourceUrl: text("source_url"),
    acl: jsonb("acl").$type<string[]>().notNull().default([]),
    /**
     * Upstream permission container this document was last assigned to by the
     * permission-sync pass (matches `kb_container_acls.container_key`, e.g.
     * `space:DEV` or `space:DEV/page:12345`). Bookkeeping only — access flows
     * through the `container:` token in `acl`. NULL = not yet assigned
     * (fail-closed until the next pass) or a non-auto-sync connector.
     */
    containerKey: text("container_key"),
    metadata: jsonb("metadata").$type<KbDocumentMetadata>().default({}),
    embeddingStatus: text("embedding_status")
      .$type<EmbeddingStatus>()
      .notNull()
      .default("pending"),
    chunkCount: integer("chunk_count").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("kb_documents_org_id_idx").on(table.organizationId),
    uniqueIndex("kb_documents_source_idx").on(
      table.connectorId,
      table.sourceId,
    ),
    // Serves the pass's per-container document scans (adopt/reassign/
    // fail-close set-diffs), including prefix ranges over nested containers.
    index("kb_documents_container_idx").on(
      table.connectorId,
      table.containerKey,
    ),
  ],
);

export default kbDocumentsTable;
