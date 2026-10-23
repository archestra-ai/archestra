import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ToolParametersContent } from "@/types";
import a2aConnectionsTable from "./a2a-connection";
import agentsTable from "./agent";
import mcpCatalogTable from "./internal-mcp-catalog";
import { softDeletablePgTable } from "./soft-deletable-table";

/** Partial unique index enforcing one row per (catalog_id, name) for built-in Archestra tools. */
export const ARCHESTRA_TOOL_NAME_UNIQUE_INDEX =
  "tools_archestra_catalog_name_uidx";

/**
 * A tool's MCP App `ui://` resource URI, or NULL when the tool is not a UI app.
 * Canonical `_meta.ui.resourceUri` first, then the legacy flat `ui/resourceUri`
 * key; both must use the `ui://` scheme.
 *
 * Defined here because `tools_ui_resource_catalog_idx` is a partial index on
 * this exact expression: Postgres only uses a partial index when the query's
 * condition matches its predicate, so the queries and the index must build it
 * from the same function.
 */
export function toolUiResourceUriExpression(
  meta: AnyPgColumn,
): SQL<string | null> {
  return sql<string | null>`coalesce(
    case when ${meta}->'_meta'->'ui'->>'resourceUri' like 'ui://%' then ${meta}->'_meta'->'ui'->>'resourceUri' end,
    case when ${meta}->'_meta'->>'ui/resourceUri' like 'ui://%' then ${meta}->'_meta'->>'ui/resourceUri' end
  )`;
}

const toolsTable = softDeletablePgTable(
  "tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** @deprecated No longer set by any code path. All tool-to-agent links use the agent_tools junction table. Will be dropped in a future migration. */
    agentId: uuid("agent_id").references(() => agentsTable.id, {
      onDelete: "cascade",
    }),
    // catalogId links MCP tools to their catalog item (shared across installations)
    // null for proxy-sniffed tools
    catalogId: uuid("catalog_id").references(() => mcpCatalogTable.id, {
      onDelete: "cascade",
    }),
    // delegateToAgentId links delegation tools directly to their target agent
    // When set, the tool is a delegation tool that forwards requests to the target agent
    // Used by internal agents for agent-to-agent delegation
    delegateToAgentId: uuid("delegate_to_agent_id").references(
      () => agentsTable.id,
      {
        onDelete: "cascade",
      },
    ),
    // Outbound A2A delegation tools point to a complete callable connection,
    // making the approved interface and credential context one atomic target.
    delegateToA2aConnectionId: uuid("delegate_to_a2a_connection_id").references(
      () => a2aConnectionsTable.id,
      { onDelete: "cascade" },
    ),
    name: text("name").notNull(),
    /**
     * The raw upstream tool name as advertised by the MCP server, before
     * Archestra namespaces it into `name` (`<catalogName>__<rawName>`). Stored
     * so the exact upstream name is recovered at dispatch/re-sync without
     * splitting the (potentially truncated) slug — a raw name may itself contain
     * "__", and long names truncate the slug's server-prefix. Populated on every
     * write path going forward and backfilled for existing rows whose `name`
     * contains "__" (including `agent__`/`archestra__` rows, where it is inert —
     * only the upstream-MCP-call path reads it). Null for rows whose `name` has
     * no separator or that predate the column and have not re-synced; dispatch
     * and sync fall back to splitting `name` when null.
     */
    rawName: text("raw_name"),
    parameters: jsonb("parameters")
      .$type<ToolParametersContent>()
      .notNull()
      .default({}),
    description: text("description"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    /**
     * True for tools copied from a clone source at clone-create time that have
     * not yet been confirmed by the clone's first install. Provisional tools
     * are excluded from agent-assignment listings/validation and have no
     * agent_tools rows, so they are never exposed at runtime. Cleared (or the
     * row deleted) during first-install reconciliation.
     */
    clonedPendingDiscovery: boolean("cloned_pending_discovery")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Unique constraint ensures:
    // - For MCP tools: one tool per (catalogId, name) combination
    // - For proxy-sniffed tools: one tool per (agentId, name) combination
    // - For delegation tools: one tool per delegateToAgentId
    unique().on(
      table.catalogId,
      table.name,
      table.agentId,
      table.delegateToAgentId,
    ),
    // Built-in Archestra tools have agent_id and delegate_to_agent_id NULL, so the
    // composite unique() above is NULLS-DISTINCT and never enforces uniqueness for them.
    // Enforce one row per (catalog_id, name) within the Archestra built-in catalog.
    // The catalog id is inlined as a literal (index predicates can't be parameterized).
    uniqueIndex(ARCHESTRA_TOOL_NAME_UNIQUE_INDEX)
      .on(table.catalogId, table.name)
      .where(
        sql`${table.catalogId} = ${sql.raw(`'${ARCHESTRA_MCP_CATALOG_ID}'`)} and ${table.agentId} is null and ${table.delegateToAgentId} is null and ${table.deletedAt} is null`,
      ),
    // The column is null for every pre-existing tool and populated only by the
    // outbound registry, so this partial index protects the one-connection/
    // one-callable-tool invariant without changing legacy tool uniqueness.
    uniqueIndex("tools_a2a_connection_uidx")
      .on(table.delegateToA2aConnectionId)
      .where(sql`${table.delegateToA2aConnectionId} is not null`),
    // Index for delegation tool lookups
    index("tools_delegate_to_agent_id_idx").on(table.delegateToAgentId),
    index("tools_cloned_pending_discovery_idx").on(
      table.clonedPendingDiscovery,
    ),
    index("tools_deleted_at_idx").on(table.deletedAt),
    // Only a few dozen of the tens of thousands of tools render an MCP App, and
    // the apps listing (the sidebar's pinned apps included) looks for exactly
    // those on every request. Without this, finding them reads every tool row.
    index("tools_ui_resource_catalog_idx")
      .on(table.catalogId)
      .where(sql`${toolUiResourceUriExpression(table.meta)} is not null`),
  ],
);

export default toolsTable;
