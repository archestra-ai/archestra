import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  OptimizationRuleConditions,
  OptimizationRuleEntityType,
  OptimizationRuleType,
  SupportedProvider,
} from "@/types";

const optimizationRulesTable = pgTable(
  "optimization_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: varchar("entity_type")
      .$type<OptimizationRuleEntityType>()
      .notNull(),
    entityId: text("entity_id").notNull(),
    ruleType: text("rule_type").$type<OptimizationRuleType>().notNull(),
    conditions: jsonb("conditions")
      .$type<OptimizationRuleConditions>()
      .notNull(),
    provider: text("provider").$type<SupportedProvider>().notNull(),
    targetModel: text("target_model").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    entityIdx: index("optimization_rules_entity_idx").on(
      table.entityType,
      table.entityId,
    ),
  }),
);

export default optimizationRulesTable;
