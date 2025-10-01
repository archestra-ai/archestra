import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";

const chatsTable = pgTable("chats", {
  id: uuid("id").primaryKey().defaultRandom(),
  hashForId: text("hash_for_id"),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agentsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default chatsTable;
