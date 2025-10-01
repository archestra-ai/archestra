import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import toolInvocationPoliciesTable from "./tool-invocation-policy";

const agentToolInvocationPoliciesTable = pgTable(
  "agent_tool_invocation_policies",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => toolInvocationPoliciesTable.id, {
        onDelete: "cascade",
      }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.policyId] }),
  }),
);

export default agentToolInvocationPoliciesTable;
