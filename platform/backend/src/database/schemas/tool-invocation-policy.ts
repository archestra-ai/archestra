import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AutonomyPolicyOperator, ToolInvocation } from "@/types";
import toolPoliciesTable from "./tool-policy";

const toolInvocationPoliciesTable = pgTable("tool_invocation_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  toolPolicyId: uuid("tool_policy_id")
    .notNull()
    .references(() => toolPoliciesTable.id, { onDelete: "cascade" }),
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
