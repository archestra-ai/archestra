import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import usersTable from "./user";

/**
 * Stores durable memory entries that persist across sessions.
 *
 * Scoped per user. Entries are always explicitly created or approved
 * by the user — nothing is written automatically. Approved entries
 * are injected into the system prompt at the start of each chat turn.
 */
const userMemoriesTable = pgTable(
  "user_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    /** Short label shown in the memory list */
    title: text("title").notNull(),
    /** The memory content injected into the system prompt */
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("user_memories_user_id_idx").on(table.userId),
    index("user_memories_organization_id_idx").on(table.organizationId),
  ],
);

export default userMemoriesTable;
