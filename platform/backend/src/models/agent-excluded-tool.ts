import {
  ARCHESTRA_MCP_CATALOG_ID,
  isPrefillExemptArchestraToolShortName,
} from "@archestra/shared";
import { and, asc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";

/**
 * Data access for per-agent single-tool exclusions (Auto-tool mode).
 * Pure CRUD — validation and orchestration live in
 * services/agent-tool-exclusions.ts.
 */
class AgentExcludedToolModel {
  static async findToolIdsByAgent(
    agentId: string,
    tx?: Transaction,
  ): Promise<string[]> {
    const rows = await (tx ?? db)
      .select({ toolId: schema.agentExcludedToolsTable.toolId })
      .from(schema.agentExcludedToolsTable)
      .where(eq(schema.agentExcludedToolsTable.agentId, agentId))
      .orderBy(asc(schema.agentExcludedToolsTable.toolId));

    return rows.map((row) => row.toolId);
  }

  /**
   * Excluded tool rows joined with their identity (name + catalog) and meta
   * (source of the MCP App `ui://` resource URI), for enforcement callers
   * that resolve tools by name or resource URI rather than row id.
   */
  static async findExcludedToolRowsByAgent(agentId: string): Promise<
    Array<{
      toolId: string;
      name: string;
      catalogId: string | null;
      meta: Record<string, unknown> | null;
    }>
  > {
    return db
      .select({
        toolId: schema.agentExcludedToolsTable.toolId,
        name: schema.toolsTable.name,
        catalogId: schema.toolsTable.catalogId,
        meta: schema.toolsTable.meta,
      })
      .from(schema.agentExcludedToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentExcludedToolsTable.toolId, schema.toolsTable.id),
      )
      .where(eq(schema.agentExcludedToolsTable.agentId, agentId))
      .orderBy(asc(schema.agentExcludedToolsTable.toolId));
  }

  /**
   * Full replace of the agent's excluded tool set. Accepts an optional
   * transaction handle so the service can replace both exclusion tables
   * atomically.
   */
  static async replaceForAgent(
    agentId: string,
    toolIds: string[],
    tx?: Transaction,
  ): Promise<void> {
    const executor = tx ?? db;
    await executor
      .delete(schema.agentExcludedToolsTable)
      .where(eq(schema.agentExcludedToolsTable.agentId, agentId));

    if (toolIds.length > 0) {
      await executor
        .insert(schema.agentExcludedToolsTable)
        .values(toolIds.map((toolId) => ({ agentId, toolId })))
        .onConflictDoNothing();
    }
  }

  /**
   * Pre-fill the agent's exclusion list for "Auto" mode: every built-in
   * Archestra tool that is not assigned to the agent and whose short name is
   * not pre-fill-exempt gets an exclusion row. Additive and idempotent —
   * existing rows are never updated or deleted, so callers can re-run it on
   * every off→on switch. Returns the number of rows inserted.
   */
  static async prefillForAllToolsMode(
    agentId: string,
    tx?: Transaction,
  ): Promise<number> {
    return AgentExcludedToolModel.insertBuiltInPrefillRows({
      agentIds: [agentId],
      executor: tx ?? db,
    });
  }

  /**
   * Set-based variant of {@link prefillForAllToolsMode} for bulk agent
   * creation paths (e.g. the personal MCP gateway startup backfill).
   */
  static async prefillManyForAllToolsMode(
    agentIds: string[],
    tx?: Transaction,
  ): Promise<number> {
    if (agentIds.length === 0) return 0;
    return AgentExcludedToolModel.insertBuiltInPrefillRows({
      agentIds,
      executor: tx ?? db,
    });
  }

  /**
   * Seed hook: when new built-in tools first appear (returned by
   * seedArchestraTools), pre-exclude them for every existing All-tools-mode
   * agent so a new built-in never silently reaches those agents. Runs after
   * the skill/app assignment backfills, so a tool those just assigned is
   * skipped. Exempt short names are skipped like the per-agent pre-fill.
   * Returns the number of rows inserted.
   */
  static async prefillNewBuiltInToolsForAllToolsAgents(
    toolIds: string[],
  ): Promise<number> {
    if (toolIds.length === 0) return 0;
    return AgentExcludedToolModel.insertBuiltInPrefillRows({
      toolIds,
      executor: db,
    });
  }

  /**
   * Insert-only core of the All-tools pre-fill. Candidate rows are the cross
   * product of the target agents (explicit ids, or every non-deleted agent
   * with access_all_tools on) and the built-in catalog tools (optionally
   * limited to the given ids) minus existing agent_tools assignments; exempt
   * short names (resolved via the branding singleton, so both the default and
   * a white-labeled prefix match) are filtered out before insert.
   *
   * When given explicit agentIds the agents' access_all_tools flag is NOT
   * checked: the create path pre-fills inside the same transaction that flips
   * the flag on, i.e. before the flag is visible.
   */
  private static async insertBuiltInPrefillRows(params: {
    executor: Transaction | typeof db;
    agentIds?: string[];
    toolIds?: string[];
  }): Promise<number> {
    const { executor, agentIds, toolIds } = params;

    const agentConditions: SQL[] = agentIds
      ? [inArray(schema.agentsTable.id, agentIds)]
      : [
          eq(schema.agentsTable.accessAllTools, true),
          notDeleted(schema.agentsTable),
        ];

    // Built-in tool rows: fixed catalog id, and neither a delegation tool nor
    // an agent-discovered row that merely shares the catalog.
    const toolConditions: SQL[] = [
      eq(schema.toolsTable.catalogId, ARCHESTRA_MCP_CATALOG_ID),
      isNull(schema.toolsTable.agentId),
      isNull(schema.toolsTable.delegateToAgentId),
    ];
    if (toolIds) {
      toolConditions.push(inArray(schema.toolsTable.id, toolIds));
    }

    const candidates = await executor
      .select({
        agentId: schema.agentsTable.id,
        toolId: schema.toolsTable.id,
        toolName: schema.toolsTable.name,
      })
      .from(schema.agentsTable)
      .innerJoin(schema.toolsTable, and(...toolConditions))
      .where(
        and(
          ...agentConditions,
          sql`not exists (select 1 from ${schema.agentToolsTable} where ${schema.agentToolsTable.agentId} = ${schema.agentsTable.id} and ${schema.agentToolsTable.toolId} = ${schema.toolsTable.id})`,
        ),
      );

    const rows = candidates
      .filter((candidate) => {
        const shortName = archestraMcpBranding.getToolShortName(
          candidate.toolName,
        );
        return (
          shortName === null ||
          !isPrefillExemptArchestraToolShortName(shortName)
        );
      })
      .map(({ agentId, toolId }) => ({ agentId, toolId }));

    if (rows.length === 0) return 0;

    const inserted = await executor
      .insert(schema.agentExcludedToolsTable)
      .values(rows)
      .onConflictDoNothing()
      .returning({ toolId: schema.agentExcludedToolsTable.toolId });

    return inserted.length;
  }
}

export default AgentExcludedToolModel;
