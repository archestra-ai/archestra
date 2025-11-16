import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  OptimizationRuleConditions,
  OptimizationRuleType,
  SupportedProvider,
} from "@/types";
import agentsTable from "./agent";

const optimizationRulesTable = pgTable("optimization_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agentsTable.id, { onDelete: "cascade" }),
  ruleType: text("rule_type").$type<OptimizationRuleType>().notNull(),
  conditions: jsonb("conditions").$type<OptimizationRuleConditions>().notNull(),
  provider: text("provider").$type<SupportedProvider>().notNull(),
  targetModel: text("target_model").notNull(),
  priority: integer("priority").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default optimizationRulesTable;
