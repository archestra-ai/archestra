import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AutonomyPolicyOperator, TrustedData } from "../../types";
import toolsTable from "./tool";

const trustedDataPoliciesTable = pgTable("trusted_data_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  toolId: uuid("tool_id")
    .notNull()
    .references(() => toolsTable.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  attributePath: text("attribute_path").notNull(),
  operator: text("operator")
    .$type<AutonomyPolicyOperator.SupportedOperator>()
    .notNull(),
  value: text("value").notNull(),
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
