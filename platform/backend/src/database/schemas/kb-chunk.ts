import {
  DEFAULT_TEXT_SEARCH_LANGUAGE,
  type TextSearchLanguage,
} from "@archestra/shared";
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
const vector1024 = createVectorType(1024);
const vector768 = createVectorType(768);
const vector384 = createVectorType(384);
const vector3072 = createVectorType(3072);

const tsvector = customType<{ data: string; driverParam: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * A PostgreSQL text-search configuration name (`english`, `german`, `simple`,
 * ...). Typed as `regconfig` rather than `text` so the generated
 * `search_vector` column can pass it straight to `to_tsvector` — that function
 * is IMMUTABLE over `(regconfig, text)`, which a generated column requires,
 * while a `text::regconfig` cast is only STABLE and would be rejected.
 */
const regconfig = customType<{
  data: TextSearchLanguage;
  driverParam: string;
}>({
  dataType() {
    return "regconfig";
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
    embedding1024: vector1024("embedding_1024"),
    embedding768: vector768("embedding_768"),
    embedding384: vector384("embedding_384"),
    embedding3072: vector3072("embedding_3072"),
    searchVector: tsvector("search_vector"),
    metadataSuffixSemantic: text("metadata_suffix_semantic"),
    metadataSuffixKeyword: text("metadata_suffix_keyword"),
    /**
     * Document-level context produced once per document at ingest and copied
     * onto each of its chunks (contextual retrieval). Denormalized rather than
     * joined from `kb_documents` because the generated `search_vector` column
     * can only reference columns of its own row.
     *
     * Prepended to the chunk's embedding input and folded into `search_vector`,
     * but deliberately NOT part of `content` — it is an indexing-time retrieval
     * signal, not text the model needs repeated on every returned chunk.
     */
    contextualHeader: text("contextual_header"),
    /**
     * Text-search configuration for this chunk's keyword index, inherited from
     * its connector at ingest. Stored per chunk so one deployment can index an
     * English wiki and a German one correctly at the same time.
     */
    ftsLanguage: regconfig("fts_language")
      .notNull()
      .default(DEFAULT_TEXT_SEARCH_LANGUAGE),
    acl: jsonb("acl").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("kb_chunks_document_id_idx").on(table.documentId)],
);

export default kbChunksTable;
