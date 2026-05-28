import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import usersTable from "./user";

const agentVersionsTable = pgTable(
  "agent_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    source: text("source").notNull(),
    createdBy: text("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("agent_versions_agent_id_version_number_uniq").on(
      table.agentId,
      table.versionNumber,
    ),
    index("agent_versions_agent_id_created_at_idx").on(
      table.agentId,
      table.createdAt,
    ),
    index("agent_versions_org_id_idx").on(table.organizationId),
  ],
);

export default agentVersionsTable;
