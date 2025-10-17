import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ToolParametersContent, ToolResultTreatment } from "@/types";
import agentsTable from "./agent";

const toolsTable = pgTable(
  "tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    parameters: jsonb("parameters")
      .$type<ToolParametersContent>()
      .notNull()
      .default({}),
    description: text("description"),
    allowUsageWhenUntrustedDataIsPresent: boolean(
      "allow_usage_when_untrusted_data_is_present",
    )
      .notNull()
      .default(false),
    toolResultTreatment: text("tool_result_treatment")
      .$type<ToolResultTreatment>()
      .notNull()
      .default("untrusted"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique().on(table.agentId, table.name)],
);

export default toolsTable;
