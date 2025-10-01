import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import toolsTable from "./tool";

const toolInvocationPoliciesTable = pgTable("tool_invocation_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  toolId: uuid("tool_id")
    .notNull()
    .references(() => toolsTable.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  argumentName: text("argument_name").notNull(),
  operator: text("operator").notNull(),
  value: text("value").notNull(),
  action: text("action").$type<"allow" | "block">().notNull(),
  blockPrompt: text("block_prompt"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default toolInvocationPoliciesTable;
