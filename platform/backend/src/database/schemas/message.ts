import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import conversationsTable from "./conversation";

const messagesTable = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    // Monotonic insertion order. createdAt has finite precision and two
    // messages written back-to-back can tie, which made "subsequent
    // messages" (strictly-greater createdAt) silently miss the later one.
    // Sequence default rather than an identity column so the migration can
    // backfill history in (created_at, id) order and old writers keep
    // inserting during rollout; NOT NULL lands in a later contract-phase
    // migration per the migration linter's expand/contract rule.
    seq: bigint("seq", { mode: "number" }).default(
      sql`nextval('messages_seq_seq')`,
    ),
    // biome-ignore lint/suspicious/noExplicitAny: Stores complete UIMessage structure from AI SDK which is dynamic
    content: jsonb("content").$type<any>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }),
  },
  (table) => ({
    conversationIdIdx: index("messages_conversation_id_idx").on(
      table.conversationId,
    ),
    conversationIdSeqIdx: index("messages_conversation_id_seq_idx").on(
      table.conversationId,
      table.seq,
    ),
    // Note: Additional pg_trgm GIN index for search is created in migration 0117_messages_content_trgm_idx.sql:
    // - messages_content_trgm_idx: GIN index on (content::text)
  }),
);

export default messagesTable;
