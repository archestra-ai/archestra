import {
  boolean,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ToolResultTreatment } from "@/types";
import organizationsTable from "./organization";
import toolsTable from "./tool";

const toolPoliciesTable = pgTable("tool_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  name: text("name").notNull().unique(),
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
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
});

export default toolPoliciesTable;
