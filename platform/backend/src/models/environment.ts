import { and, asc, count, eq, isNull, ne, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { NetworkPolicy } from "@/types";

// === Public API ===

interface EnvironmentWithAssignedCount {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  namespace: string | null;
  networkPolicy: NetworkPolicy | null;
  restricted: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  assignedCatalogCount: number;
}

class EnvironmentModel {
  static async listForOrganization(
    organizationId: string,
  ): Promise<EnvironmentWithAssignedCount[]> {
    return db
      .select({
        id: schema.environmentsTable.id,
        organizationId: schema.environmentsTable.organizationId,
        name: schema.environmentsTable.name,
        description: schema.environmentsTable.description,
        namespace: schema.environmentsTable.namespace,
        networkPolicy: schema.environmentsTable.networkPolicy,
        restricted: schema.environmentsTable.restricted,
        sortOrder: schema.environmentsTable.sortOrder,
        createdAt: schema.environmentsTable.createdAt,
        updatedAt: schema.environmentsTable.updatedAt,
        assignedCatalogCount: count(schema.internalMcpCatalogTable.id),
      })
      .from(schema.environmentsTable)
      .leftJoin(
        schema.internalMcpCatalogTable,
        eq(
          schema.internalMcpCatalogTable.environmentId,
          schema.environmentsTable.id,
        ),
      )
      .where(eq(schema.environmentsTable.organizationId, organizationId))
      .groupBy(schema.environmentsTable.id)
      .orderBy(
        asc(schema.environmentsTable.sortOrder),
        asc(schema.environmentsTable.createdAt),
      );
  }

  static async findById(
    id: string,
  ): Promise<typeof schema.environmentsTable.$inferSelect | null> {
    const [row] = await db
      .select()
      .from(schema.environmentsTable)
      .where(eq(schema.environmentsTable.id, id))
      .limit(1);
    return row ?? null;
  }

  static async findByIdForOrganization(
    id: string,
    organizationId: string,
  ): Promise<typeof schema.environmentsTable.$inferSelect | null> {
    const [row] = await db
      .select()
      .from(schema.environmentsTable)
      .where(
        and(
          eq(schema.environmentsTable.id, id),
          eq(schema.environmentsTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    return EnvironmentModel.findByIdForOrganization(id, organizationId);
  }

  static async create(params: {
    organizationId: string;
    name: string;
    description?: string | null;
    namespace?: string | null;
    networkPolicy?: NetworkPolicy | null;
    restricted?: boolean;
  }): Promise<typeof schema.environmentsTable.$inferSelect> {
    const {
      organizationId,
      name,
      description,
      namespace,
      networkPolicy,
      restricted,
    } = params;
    const [row] = await db
      .insert(schema.environmentsTable)
      .values({
        organizationId,
        name,
        description: description ?? null,
        namespace: namespace ?? null,
        networkPolicy: networkPolicy ?? null,
        restricted: restricted ?? false,
        sortOrder: await EnvironmentModel.nextSortOrder(organizationId),
      })
      .returning();
    return row;
  }

  static async update(params: {
    id: string;
    organizationId: string;
    name?: string;
    description?: string | null;
    namespace?: string | null;
    networkPolicy?: NetworkPolicy | null;
    restricted?: boolean;
  }): Promise<typeof schema.environmentsTable.$inferSelect | null> {
    const {
      id,
      organizationId,
      name,
      description,
      namespace,
      networkPolicy,
      restricted,
    } = params;
    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (namespace !== undefined) patch.namespace = namespace;
    if (networkPolicy !== undefined) patch.networkPolicy = networkPolicy;
    if (restricted !== undefined) patch.restricted = restricted;

    const [row] = await db
      .update(schema.environmentsTable)
      .set(patch)
      .where(
        and(
          eq(schema.environmentsTable.id, id),
          eq(schema.environmentsTable.organizationId, organizationId),
        ),
      )
      .returning();
    return row ?? null;
  }

  static async countAssignedCatalogItems(
    environmentId: string,
  ): Promise<number> {
    const [row] = await db
      .select({ count: count(schema.internalMcpCatalogTable.id) })
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.environmentId, environmentId));
    return row?.count ?? 0;
  }

  /**
   * Count top-level catalog items with no environment assigned — these
   * implicitly belong to the org's default environment. Mirrors what's counted
   * per real environment: built-in catalogs (e.g. the Archestra tools) and
   * preset children are excluded. Catalog items can carry a null
   * organization_id (they're org-scoped via team membership), so we include
   * those alongside the org's own items.
   */
  static async countDefaultAssigned(organizationId: string): Promise<number> {
    const [row] = await db
      .select({ count: count(schema.internalMcpCatalogTable.id) })
      .from(schema.internalMcpCatalogTable)
      .where(
        and(
          isNull(schema.internalMcpCatalogTable.environmentId),
          isNull(schema.internalMcpCatalogTable.parentCatalogItemId),
          ne(schema.internalMcpCatalogTable.serverType, "builtin"),
          or(
            eq(schema.internalMcpCatalogTable.organizationId, organizationId),
            isNull(schema.internalMcpCatalogTable.organizationId),
          ),
        ),
      );
    return row?.count ?? 0;
  }

  static async delete(id: string, organizationId: string): Promise<boolean> {
    // The FK is ON DELETE SET NULL as a safety net, but the service blocks
    // deletion while catalog items are still assigned (see deleteEnvironment).
    const deleted = await db
      .delete(schema.environmentsTable)
      .where(
        and(
          eq(schema.environmentsTable.id, id),
          eq(schema.environmentsTable.organizationId, organizationId),
        ),
      )
      .returning({ id: schema.environmentsTable.id });
    return deleted.length > 0;
  }

  // === Internal helpers ===

  private static async nextSortOrder(organizationId: string): Promise<number> {
    const [row] = await db
      .select({
        max: sql<number | null>`MAX(${schema.environmentsTable.sortOrder})`,
      })
      .from(schema.environmentsTable)
      .where(eq(schema.environmentsTable.organizationId, organizationId));
    return (row?.max ?? -1) + 1;
  }
}

export default EnvironmentModel;
