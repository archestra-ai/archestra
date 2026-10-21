import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";

/**
 * Tool descriptions as each MCP server installation reported them. See the
 * `mcp_server_tool_descriptions` schema for why the shared `tools` row is not
 * enough.
 */
class McpServerToolDescriptionModel {
  /**
   * Replace an installation's recorded descriptions with the ones from its
   * latest `tools/list`. Tools it no longer reports are forgotten.
   */
  static async replaceForServer(params: {
    mcpServerId: string;
    descriptions: Array<{ toolId: string; description: string | null }>;
  }): Promise<void> {
    const { mcpServerId, descriptions } = params;
    const toolIds = descriptions.map((entry) => entry.toolId);
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.mcpServerToolDescriptionsTable)
        .where(
          and(
            eq(schema.mcpServerToolDescriptionsTable.mcpServerId, mcpServerId),
            toolIds.length > 0
              ? notInArray(
                  schema.mcpServerToolDescriptionsTable.toolId,
                  toolIds,
                )
              : undefined,
          ),
        );
      if (descriptions.length === 0) {
        return;
      }
      await tx
        .insert(schema.mcpServerToolDescriptionsTable)
        .values(
          descriptions.map((entry) => ({
            mcpServerId,
            toolId: entry.toolId,
            description: entry.description,
          })),
        )
        .onConflictDoUpdate({
          target: [
            schema.mcpServerToolDescriptionsTable.mcpServerId,
            schema.mcpServerToolDescriptionsTable.toolId,
          ],
          set: {
            description: sql`excluded.description`,
            updatedAt: new Date(),
          },
        });
    });
  }

  /**
   * The subset of `toolIds` for which at least one installation reported a
   * description that differs from the shared `tools` row. Only these tools
   * need a per-caller description; for every other tool the shared row
   * already says what each installation says.
   */
  static async findToolIdsWithDivergentDescriptions(
    toolIds: string[],
  ): Promise<Set<string>> {
    if (toolIds.length === 0) {
      return new Set();
    }
    const rows = await db
      .selectDistinct({ toolId: schema.mcpServerToolDescriptionsTable.toolId })
      .from(schema.mcpServerToolDescriptionsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.toolsTable.id, schema.mcpServerToolDescriptionsTable.toolId),
      )
      .where(
        and(
          inArray(schema.mcpServerToolDescriptionsTable.toolId, toolIds),
          sql`${schema.mcpServerToolDescriptionsTable.description} is distinct from ${schema.toolsTable.description}`,
        ),
      );
    return new Set(rows.map((row) => row.toolId));
  }

  /**
   * Recorded descriptions for the given (installation, tool) pairs, as
   * installation id -> tool id -> description. Pairs with no recorded
   * description are absent.
   */
  static async findForPairs(
    pairs: Array<{ mcpServerId: string; toolId: string }>,
  ): Promise<Map<string, Map<string, string | null>>> {
    const byServer = new Map<string, Map<string, string | null>>();
    if (pairs.length === 0) {
      return byServer;
    }
    const wanted = new Set(
      pairs.map((pair) => `${pair.mcpServerId}:${pair.toolId}`),
    );
    const rows = await db
      .select({
        mcpServerId: schema.mcpServerToolDescriptionsTable.mcpServerId,
        toolId: schema.mcpServerToolDescriptionsTable.toolId,
        description: schema.mcpServerToolDescriptionsTable.description,
      })
      .from(schema.mcpServerToolDescriptionsTable)
      .where(
        and(
          inArray(schema.mcpServerToolDescriptionsTable.mcpServerId, [
            ...new Set(pairs.map((pair) => pair.mcpServerId)),
          ]),
          inArray(schema.mcpServerToolDescriptionsTable.toolId, [
            ...new Set(pairs.map((pair) => pair.toolId)),
          ]),
        ),
      );
    for (const row of rows) {
      if (!wanted.has(`${row.mcpServerId}:${row.toolId}`)) continue;
      const forServer = byServer.get(row.mcpServerId) ?? new Map();
      forServer.set(row.toolId, row.description);
      byServer.set(row.mcpServerId, forServer);
    }
    return byServer;
  }
}

export default McpServerToolDescriptionModel;
