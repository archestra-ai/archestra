import { and, asc, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import InternalMcpCatalogModel from "./internal-mcp-catalog";

interface PresetEntryWithAssignedCount {
  id: string;
  organizationId: string;
  name: string;
  sortOrder: number;
  createdAt: Date;
  assignedCatalogCount: number;
}

class McpPresetEntryModel {
  static async listForOrganization(
    organizationId: string,
  ): Promise<PresetEntryWithAssignedCount[]> {
    const rows = await db
      .select({
        id: schema.mcpPresetEntriesTable.id,
        organizationId: schema.mcpPresetEntriesTable.organizationId,
        name: schema.mcpPresetEntriesTable.name,
        sortOrder: schema.mcpPresetEntriesTable.sortOrder,
        createdAt: schema.mcpPresetEntriesTable.createdAt,
        assignedCatalogCount: sql<number>`(
          SELECT COUNT(*)::int
          FROM ${schema.internalMcpCatalogTable}
          WHERE ${schema.internalMcpCatalogTable.presetEntryId} = ${schema.mcpPresetEntriesTable.id}
        )`,
      })
      .from(schema.mcpPresetEntriesTable)
      .where(eq(schema.mcpPresetEntriesTable.organizationId, organizationId))
      .orderBy(
        asc(schema.mcpPresetEntriesTable.sortOrder),
        asc(schema.mcpPresetEntriesTable.createdAt),
      );

    return rows;
  }

  static async findByIdForOrganization(
    id: string,
    organizationId: string,
  ): Promise<typeof schema.mcpPresetEntriesTable.$inferSelect | null> {
    const [row] = await db
      .select()
      .from(schema.mcpPresetEntriesTable)
      .where(
        and(
          eq(schema.mcpPresetEntriesTable.id, id),
          eq(schema.mcpPresetEntriesTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  static async create(params: {
    organizationId: string;
    name: string;
  }): Promise<typeof schema.mcpPresetEntriesTable.$inferSelect> {
    const { organizationId, name } = params;
    const [row] = await db
      .insert(schema.mcpPresetEntriesTable)
      .values({
        organizationId,
        name,
        sortOrder: await McpPresetEntryModel.nextSortOrder(organizationId),
      })
      .returning();
    return row;
  }

  static async delete(id: string, organizationId: string): Promise<boolean> {
    const entry = await McpPresetEntryModel.findByIdForOrganization(
      id,
      organizationId,
    );
    if (!entry) return false;

    // Tear down per-entry catalog rows through the model so installed MCP
    // servers (K8s pods, agent_tools, sessions, the mcp_server row itself)
    // are cleaned up. A raw cascade would skip all of that and also collide
    // with the mcp_server.catalog_id NOT NULL constraint.
    const childIds = await db
      .select({ id: schema.internalMcpCatalogTable.id })
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.presetEntryId, id));

    for (const child of childIds) {
      await InternalMcpCatalogModel.delete(child.id);
    }

    const deleted = await db
      .delete(schema.mcpPresetEntriesTable)
      .where(
        and(
          eq(schema.mcpPresetEntriesTable.id, id),
          eq(schema.mcpPresetEntriesTable.organizationId, organizationId),
        ),
      )
      .returning({ id: schema.mcpPresetEntriesTable.id });
    return deleted.length > 0;
  }

  private static async nextSortOrder(organizationId: string): Promise<number> {
    const [row] = await db
      .select({
        max: sql<number | null>`MAX(${schema.mcpPresetEntriesTable.sortOrder})`,
      })
      .from(schema.mcpPresetEntriesTable)
      .where(eq(schema.mcpPresetEntriesTable.organizationId, organizationId));
    return (row?.max ?? -1) + 1;
  }
}

export default McpPresetEntryModel;
