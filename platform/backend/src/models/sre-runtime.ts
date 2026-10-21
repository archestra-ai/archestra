import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";

// === Public API ===

/**
 * Lookups for the seeded SRE agent's rows. They include soft-deleted rows on
 * purpose: a row an admin deleted is the marker that keeps it from being
 * seeded again.
 */
class SreRuntimeModel {
  static async findCatalog(id: string): Promise<{
    id: string;
    organizationId: string | null;
    authorId: string | null;
    deletedAt: Date | null;
  } | null> {
    const [row] = await db
      .select({
        id: schema.internalMcpCatalogTable.id,
        organizationId: schema.internalMcpCatalogTable.organizationId,
        authorId: schema.internalMcpCatalogTable.authorId,
        deletedAt: schema.internalMcpCatalogTable.deletedAt,
      })
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, id))
      .limit(1);
    return row ?? null;
  }

  static async findServerIds(catalogId: string): Promise<string[]> {
    const rows = await db
      .select({ id: schema.mcpServersTable.id })
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.catalogId, catalogId));
    return rows.map(({ id }) => id);
  }

  static async findAgent(id: string): Promise<{
    id: string;
    deletedAt: Date | null;
    latestVersion: number;
  } | null> {
    const [row] = await db
      .select({
        id: schema.agentsTable.id,
        deletedAt: schema.agentsTable.deletedAt,
        latestVersion: schema.agentsTable.latestVersion,
      })
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, id))
      .limit(1);
    return row ?? null;
  }

  static async findEarliestAdminUserId(
    organizationId: string,
  ): Promise<string | null> {
    const [row] = await db
      .select({ userId: schema.membersTable.userId })
      .from(schema.membersTable)
      .where(
        and(
          eq(schema.membersTable.organizationId, organizationId),
          eq(schema.membersTable.role, ADMIN_ROLE_NAME),
        ),
      )
      .orderBy(asc(schema.membersTable.createdAt))
      .limit(1);
    return row?.userId ?? null;
  }

  /** Live tools of the catalog whose upstream name is one of `rawNames`. */
  static async findToolsByRawName(params: {
    catalogId: string;
    rawNames: readonly string[];
  }): Promise<Array<{ id: string; rawName: string | null }>> {
    return db
      .select({ id: schema.toolsTable.id, rawName: schema.toolsTable.rawName })
      .from(schema.toolsTable)
      .where(
        and(
          eq(schema.toolsTable.catalogId, params.catalogId),
          inArray(schema.toolsTable.rawName, [...params.rawNames]),
          notDeleted(schema.toolsTable),
        ),
      );
  }
}

export default SreRuntimeModel;
