import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import kbDocumentsTable from "./kb-document";

function createVectorType(dimensions: number) {
  return customType<{ data: number[]; driverParam: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(",")}]`;
    },
    fromDriver(value: unknown): number[] {
      const str = value as string;
      return str.slice(1, -1).split(",").map(Number);
    },
  });
}

const vector1536 = createVectorType(1536);
const vector768 = createVectorType(768);

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
    content: text("content").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    embedding: vector1536("embedding"),
    embedding768: vector768("embedding_768"),
    searchVector: tsvector("search_vector"),
    acl: jsonb("acl").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("kb_chunks_document_id_idx").on(table.documentId)],
);

export default kbChunksTable;
