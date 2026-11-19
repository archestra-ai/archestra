import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ToolSearchTextStatus } from "@/types/tool-search-text";

/**
 * Generated `search_tools` vocabulary, addressed by a hash of the tool
 * definition it describes, so a changed definition simply stops matching.
 *
 * `status`, `prompt_version` and `generator` describe the latest attempt, while
 * `search_text` is the last good result: a failed regeneration keeps serving it.
 */
const toolSearchTextsTable = pgTable("tool_search_texts", {
  definitionHash: text("definition_hash").primaryKey(),
  searchText: text("search_text"),
  status: text("status").$type<ToolSearchTextStatus>().notNull(),
  promptVersion: integer("prompt_version").notNull(),
  generator: text("generator").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

export default toolSearchTextsTable;
