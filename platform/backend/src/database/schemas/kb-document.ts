import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { EmbeddingStatus, KbDocumentMetadata } from "@/types/kb-document";
import knowledgeBaseConnectorsTable from "./knowledge-base-connector";

export const kbDocumentEmbeddingErrorEnum = pgEnum(
  "kb_document_embedding_error",
  [
    "rate_limit",
    "auth_error",
    "model_not_found",
    "server_error",
    "dimensions_mismatch",
    "unknown",
  ],
);

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
    metadata: jsonb("metadata").$type<KbDocumentMetadata>().default({}),
    embeddingStatus: text("embedding_status")
      .$type<EmbeddingStatus>()
      .notNull()
      .default("pending"),
    embeddingError: kbDocumentEmbeddingErrorEnum("embedding_error"),
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
  ],
);

export default kbDocumentsTable;
