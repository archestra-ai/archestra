import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ToolParametersContent } from "../../types";

const toolsTable = pgTable("tools", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  parameters: jsonb("parameters")
    .$type<ToolParametersContent>()
    .notNull()
    .default({}),
  description: text("description"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default toolsTable;
