import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { BundleLocalMcpServer } from "@/types/bundle";
import agentsTable from "./agent";
import organizationsTable from "./organization";
import pluginsTable from "./plugin";
import skillsTable from "./skill";

const bundlesTable = pgTable(
  "capability_bundles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    mcpGatewayId: uuid("mcp_gateway_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    localMcpServers: jsonb("local_mcp_servers")
      .$type<BundleLocalMcpServer[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("capability_bundles_organization_id_idx").on(table.organizationId),
    uniqueIndex("capability_bundles_org_name_uidx").on(
      table.organizationId,
      table.name,
    ),
  ],
);

export const bundleSkillsTable = pgTable(
  "capability_bundle_skills",
  {
    bundleId: uuid("capability_bundle_id")
      .notNull()
      .references(() => bundlesTable.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skillsTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.bundleId, table.skillId] }),
    index("capability_bundle_skills_skill_id_idx").on(table.skillId),
  ],
);

export const bundlePluginsTable = pgTable(
  "capability_bundle_plugins",
  {
    bundleId: uuid("capability_bundle_id")
      .notNull()
      .references(() => bundlesTable.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => pluginsTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.bundleId, table.pluginId] }),
    index("capability_bundle_plugins_plugin_id_idx").on(table.pluginId),
  ],
);

export default bundlesTable;
