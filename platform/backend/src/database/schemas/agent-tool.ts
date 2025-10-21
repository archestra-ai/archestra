import { pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import toolsTable from "./tool";

const agentToolsTable = pgTable(
  "agent_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    toolId: uuid("tool_id")
      .notNull()
      .references(() => toolsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique().on(table.agentId, table.toolId)],
);

export default agentToolsTable;
