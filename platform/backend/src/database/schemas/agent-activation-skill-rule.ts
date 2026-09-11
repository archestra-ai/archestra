import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AgentActivationSkillRuleDisposition,
  AgentActivationSkillSource,
} from "@/types/agent-activation-skill-policy";
import agentsTable from "./agent";

/**
 * Exact source identities used by an internal agent's activation policy.
 *
 * Source columns intentionally do not reference the source tables. A source
 * may be removed or temporarily unavailable without silently changing the
 * saved policy; the opaque rule can become effective again if that stable
 * identity returns. The agent itself is the owner and cascades on deletion.
 */
const agentActivationSkillRulesTable = pgTable(
  "agent_activation_skill_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    disposition: text("disposition")
      .$type<AgentActivationSkillRuleDisposition>()
      .notNull(),
    source: text("source").$type<AgentActivationSkillSource>().notNull(),
    skillId: uuid("skill_id"),
    mcpServerId: uuid("mcp_server_id"),
    uri: text("uri"),
    pluginId: uuid("plugin_id"),
    skillPath: text("skill_path"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_activation_skill_rules_agent_id_idx").on(table.agentId),
    uniqueIndex("agent_activation_skill_rules_native_uidx")
      .on(table.agentId, table.disposition, table.skillId)
      .where(sql`${table.source} = 'native'`),
    uniqueIndex("agent_activation_skill_rules_external_mcp_uidx")
      .on(table.agentId, table.disposition, table.mcpServerId, table.uri)
      .where(sql`${table.source} = 'external_mcp'`),
    uniqueIndex("agent_activation_skill_rules_plugin_uidx")
      .on(table.agentId, table.disposition, table.pluginId, table.skillPath)
      .where(sql`${table.source} = 'plugin'`),
    check(
      "agent_activation_skill_rules_disposition_check",
      sql`${table.disposition} IN ('allow', 'exclude')`,
    ),
    check(
      "agent_activation_skill_rules_reference_check",
      sql`(
        (${table.source} = 'native' AND ${table.skillId} IS NOT NULL AND ${table.mcpServerId} IS NULL AND ${table.uri} IS NULL AND ${table.pluginId} IS NULL AND ${table.skillPath} IS NULL)
        OR
        (${table.source} = 'external_mcp' AND ${table.skillId} IS NULL AND ${table.mcpServerId} IS NOT NULL AND ${table.uri} IS NOT NULL AND ${table.pluginId} IS NULL AND ${table.skillPath} IS NULL)
        OR
        (${table.source} = 'plugin' AND ${table.skillId} IS NULL AND ${table.mcpServerId} IS NULL AND ${table.uri} IS NULL AND ${table.pluginId} IS NOT NULL AND ${table.skillPath} IS NOT NULL)
      )`,
    ),
  ],
);

export default agentActivationSkillRulesTable;
