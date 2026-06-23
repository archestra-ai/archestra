import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ConversationFileTouchKind } from "@/types/conversation-file-touch";
import conversationsTable from "./conversation";
import filesTable from "./file";

/**
 * Pre-existing files an agent referenced (read or edited) in a conversation that
 * it did NOT create there.
 *
 * "Created here" files are tracked by `files.conversation_id` (provenance) and
 * already surface as the chat's generated outputs. This table is what lets the
 * chat Files panel show the *other* files the agent actually touched — e.g. a
 * project file pulled in from the project's result folder — instead of dumping
 * every file the user can reach. One row per (conversation, file); the first
 * touch wins.
 */
const conversationFileTouchesTable = pgTable(
  "conversation_file_touches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => filesTable.id, { onDelete: "cascade" }),
    touchKind: text("touch_kind").$type<ConversationFileTouchKind>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("conversation_file_touches_conversation_id_idx").on(
      table.conversationId,
    ),
    index("conversation_file_touches_file_id_idx").on(table.fileId),
    unique("conversation_file_touches_conversation_file_uq").on(
      table.conversationId,
      table.fileId,
    ),
  ],
);

export default conversationFileTouchesTable;
