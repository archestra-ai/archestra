import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import labelKeyTable from "./label-key";
import labelValueTable from "./label-value";

const agentLabelTable = pgTable(
  "agent_labels",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    keyId: uuid("key_id")
      .notNull()
      .references(() => labelKeyTable.id, { onDelete: "cascade" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => labelValueTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.keyId] }),
  }),
);

export default agentLabelTable;
