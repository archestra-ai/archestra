import { index, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ToolContent } from "../../types";

const toolsTable = pgTable(
  "tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    definition: jsonb("definition").$type<ToolContent>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    definitionIdx: index("tools_definition_idx").on(table.definition),
  }),
);

export default toolsTable;
