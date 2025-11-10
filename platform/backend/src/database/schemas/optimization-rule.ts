import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";

export const optimizationRuleTypeEnum = pgEnum("optimization_rule_type", [
  "content_length",
  "tool_presence",
]);

export const llmProviderEnum = pgEnum("llm_provider", ["anthropic", "openai"]);

const optimizationRulesTable = pgTable("optimization_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agentsTable.id, { onDelete: "cascade" }),
  ruleType: optimizationRuleTypeEnum("rule_type").notNull(),
  conditions: jsonb("conditions").notNull(),
  provider: llmProviderEnum("provider").notNull().default("openai"),
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

// Type-safe condition types
export type ContentLengthConditions = {
  maxLength: number;
};

export type ToolPresenceConditions = {
  hasTools: boolean;
};

export type RuleConditions = ContentLengthConditions | ToolPresenceConditions;
