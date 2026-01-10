import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AutonomyPolicyOperator, ToolInvocation } from "@/types";
import agentToolsTable from "./agent-tool";

const toolInvocationPoliciesTable = pgTable("tool_invocation_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentToolId: uuid("agent_tool_id")
    .notNull()
    .references(() => agentToolsTable.id, { onDelete: "cascade" }),
  argumentName: text("argument_name").notNull(),
  operator: text("operator")
    .$type<AutonomyPolicyOperator.SupportedOperator>()
    .notNull(),
  value: text("value").notNull(),
  action: text("action")
    .$type<ToolInvocation.ToolInvocationPolicyAction>()
    .notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default toolInvocationPoliciesTable;
