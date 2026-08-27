import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import knowledgeBaseConnectorsTable from "./knowledge-base-connector";

/**
 * Per-agent knowledge-source exclusions for Auto-tool mode ("access all
 * tools"). A knowledge source is a knowledge connector — the leaf the agent
 * form lists and the unit `query_knowledge_sources` searches.
 *
 * While `agents.access_all_tools` is on, the agent's knowledge queries span
 * every connector its caller can read; an excluded connector is removed from
 * that surface. Explicit `agent_connector_assignment` / `agent_knowledge_base`
 * rows stay untouched, so Custom mode — where the assigned set is already the
 * whole surface — is unaffected, and rows here are inert when the setting is
 * off. The knowledge analog of `agent_excluded_tools`.
 */
const agentExcludedConnectorsTable = pgTable(
  "agent_excluded_connectors",
  {
    /** The agent whose Auto knowledge surface is being narrowed */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    /** The knowledge connector to exclude from that surface */
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => knowledgeBaseConnectorsTable.id, {
        onDelete: "cascade",
      }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.connectorId] })],
);

export default agentExcludedConnectorsTable;
