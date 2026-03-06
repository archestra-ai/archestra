import {
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import knowledgeBaseConnectorsTable from "./knowledge-base-connector";

const agentConnectorAssignmentsTable = pgTable(
  "agent_connector_assignment",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => knowledgeBaseConnectorsTable.id, {
        onDelete: "cascade",
      }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.connectorId] }),
    index("agent_connector_assignment_agent_idx").on(table.agentId),
    index("agent_connector_assignment_connector_idx").on(table.connectorId),
  ],
);

export default agentConnectorAssignmentsTable;
