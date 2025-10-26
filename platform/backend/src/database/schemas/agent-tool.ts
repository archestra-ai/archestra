import {
  boolean,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ToolResultTreatment } from "@/types";
import agentsTable from "./agent";
import toolsTable from "./tool";

const agentToolsTable = pgTable(
  "agent_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    toolId: uuid("tool_id")
      .notNull()
      .references(() => toolsTable.id, { onDelete: "cascade" }),
    allowUsageWhenUntrustedDataIsPresent: boolean(
      "allow_usage_when_untrusted_data_is_present",
    )
      .notNull()
      .default(false),
    toolResultTreatment: text("tool_result_treatment")
      .$type<ToolResultTreatment>()
      .notNull()
      .default("untrusted"),
    responseModifierTemplate: text("response_modifier_template"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique().on(table.agentId, table.toolId)],
);

export default agentToolsTable;
