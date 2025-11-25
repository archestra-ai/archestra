import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";

const promptsTable = pgTable("prompts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agentsTable.id, { onDelete: "cascade" }),
  userPrompt: text("user_prompt"),
  systemPrompt: text("system_prompt"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default promptsTable;
