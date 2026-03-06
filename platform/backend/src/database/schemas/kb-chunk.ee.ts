import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { customType } from "drizzle-orm/pg-core";
import kbDocumentsTable from "./kb-document.ee";
import knowledgeBasesTable from "./knowledge-base";

const vector = customType<{ data: number[]; driverParam: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: unknown): number[] {
    const str = value as string;
    return str
      .slice(1, -1)
      .split(",")
      .map(Number);
  },
});

const tsvector = customType<{ data: string; driverParam: string }>({
  dataType() {
    return "tsvector";
  },
});

const kbChunksTable = pgTable(
  "kb_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => kbDocumentsTable.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBasesTable.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    embedding: vector("embedding"),
    searchVector: tsvector("search_vector"),
    acl: jsonb("acl").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("kb_chunks_document_id_idx").on(table.documentId),
    index("kb_chunks_kb_id_idx").on(table.knowledgeBaseId),
  ],
);

export default kbChunksTable;
