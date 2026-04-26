import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const memoryScopeTypeEnum = pgEnum("memory_scope_type", [
  "user",
  "team",
  "org",
]);

const agentMemoriesTable = pgTable("agent_memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  scopeType: memoryScopeTypeEnum("scope_type").notNull(),
  scopeId: text("scope_id").notNull(),
  organizationId: text("organization_id").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export default agentMemoriesTable;
