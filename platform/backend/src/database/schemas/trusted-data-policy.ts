import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AutonomyPolicyOperator, TrustedData } from "@/types";
import toolsTable from "./tool";

/**
 * A single condition in a result policy rule.
 * All conditions must match (AND logic) for the policy action to apply.
 */
export type ResultPolicyCondition = {
  /** The attribute key or the path to check in the tool result (e.g., "emails[*].from", "source") */
  key: string;
  /** Comparison operator */
  operator: AutonomyPolicyOperator.SupportedOperator;
  /** Value to compare against */
  value: string;
};

const trustedDataPoliciesTable = pgTable("trusted_data_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  toolId: uuid("tool_id")
    .notNull()
    .references(() => toolsTable.id, { onDelete: "cascade" }),
  description: text("description"),
  conditions: jsonb("conditions")
    .$type<ResultPolicyCondition[]>()
    .notNull()
    .default([]),
  action: text("action")
    .$type<TrustedData.TrustedDataPolicyAction>()
    .notNull()
    .default("mark_as_trusted"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default trustedDataPoliciesTable;
