import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import trustedDataPoliciesTable from "./trusted-data-policy";

const agentTrustedDataPoliciesTable = pgTable(
  "agent_trusted_data_policies",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => trustedDataPoliciesTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.policyId] }),
  }),
);

export default agentTrustedDataPoliciesTable;
