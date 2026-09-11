import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import usersTable from "./user";

/**
 * A user's personal pin on an agent. Pins are caller-relative, so one member's
 * pinned Agents view never changes another member's ordering or filters.
 * `pinned_at` is both the pin marker and the newest-pin-first sort key.
 */
const agentPinsTable = pgTable(
  "agent_pins",
  {
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    pinnedAt: timestamp("pinned_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.agentId] }),
    // Backs the FK cascade delete from agents; the PK starts with user_id.
    index("agent_pins_agent_id_idx").on(table.agentId),
  ],
);

export default agentPinsTable;
