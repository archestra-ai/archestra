import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AutonomyPolicyOperator, ToolInvocation } from "@/types";
import toolsTable from "./tool";

/**
 * A single condition in a compound policy rule.
 * All conditions must match (AND logic) for the policy action to apply.
 */
export type CallPolicyCondition = {
  /**
   * The argument name to check (e.g., "query", "to", "database").
   * In the case of context entity, value is typically entity id.
   */
  key: string;
  /** Comparison operator */
  operator: AutonomyPolicyOperator.SupportedOperator;
  /** Value to compare against */
  value: string;
};

const toolInvocationPoliciesTable = pgTable("tool_invocation_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  toolId: uuid("tool_id")
    .notNull()
    .references(() => toolsTable.id, { onDelete: "cascade" }),

  conditions: jsonb("conditions")
    .$type<CallPolicyCondition[]>()
    .notNull()
    .default([]),

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
