import { index, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import type { z } from "zod";
import type { ToolSchema } from "../../types/llm-providers/openai/tools";

const toolsTable = pgTable(
  "tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    definition: jsonb("definition")
      .$type<z.infer<typeof ToolSchema>>()
      .notNull(),
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
