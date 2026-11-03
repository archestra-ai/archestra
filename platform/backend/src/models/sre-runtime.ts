import { ADMIN_ROLE_NAME, BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

// === Public API ===

/**
 * Lookups for the seeded SRE agent's rows. They include soft-deleted rows on
 * purpose: a row an admin deleted is the marker that keeps it from being
 * seeded again.
 */
class SreRuntimeModel {
  /** Transfer legacy custom-role SRE access to the catalog's object policy. */
  static async migrateLegacyRoleAccess(
    organizationId: string,
    catalogId: string,
  ): Promise<void> {
    const roles = await db
      .select({
        id: schema.organizationRolesTable.id,
        role: schema.organizationRolesTable.role,
        permission: schema.organizationRolesTable.permission,
      })
      .from(schema.organizationRolesTable)
      .where(eq(schema.organizationRolesTable.organizationId, organizationId));
    for (const role of roles) {
      let permissions: Record<string, unknown>;
      try {
        permissions = JSON.parse(role.permission);
      } catch {
        continue;
      }
      if (
        !permissions ||
        typeof permissions !== "object" ||
        Array.isArray(permissions)
      )
        continue;
      if (!Array.isArray(permissions.sre) || !permissions.sre.includes("read"))
        continue;
      const key = {
        organizationId,
        resource: "mcpRegistry" as const,
        scope: catalogId,
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        const policy = await ResourcePermissionPolicyModel.find(key);
        if (!policy) break;
        const granted = policy.grants.some(
          (grant) =>
            grant.subject.type === "role" &&
            grant.subject.id === role.id &&
            grant.actions.includes("read") &&
            grant.actions.includes("use"),
        );
        if (granted) break;
        const current = policy.grants.find(
          (grant) =>
            grant.subject.type === "role" && grant.subject.id === role.id,
        );
        const grants = policy.grants.filter(
          (grant) =>
            !(grant.subject.type === "role" && grant.subject.id === role.id),
        );
        grants.push({
          subject: { type: "role", id: role.id },
          actions: [
            ...new Set([...(current?.actions ?? []), "read", "use"] as const),
          ],
        });
        const updated = await db
          .update(schema.resourcePermissionPoliciesTable)
          .set({
            grants,
            revision: sql`${schema.resourcePermissionPoliciesTable.revision} + 1`,
          })
          .where(
            and(
              eq(
                schema.resourcePermissionPoliciesTable.organizationId,
                organizationId,
              ),
              eq(
                schema.resourcePermissionPoliciesTable.resource,
                "mcpRegistry",
              ),
              eq(schema.resourcePermissionPoliciesTable.scope, catalogId),
              eq(
                schema.resourcePermissionPoliciesTable.revision,
                policy.revision,
              ),
            ),
          )
          .returning({
            revision: schema.resourcePermissionPoliciesTable.revision,
          });
        if (updated.length > 0) break;
      }
      const policy = await ResourcePermissionPolicyModel.find(key);
      if (
        !policy?.grants.some(
          (grant) =>
            grant.subject.type === "role" &&
            grant.subject.id === role.id &&
            grant.actions.includes("read") &&
            grant.actions.includes("use"),
        )
      )
        continue;
      delete permissions.sre;
      await db
        .update(schema.organizationRolesTable)
        .set({ permission: JSON.stringify(permissions) })
        .where(
          and(
            eq(schema.organizationRolesTable.id, role.id),
            eq(schema.organizationRolesTable.permission, role.permission),
          ),
        );
    }
  }
  /** Upgrade a live legacy SRE row in place, keeping its ID and grants. */
  static async markAgentBuiltIn(id: string): Promise<void> {
    await db
      .update(schema.agentsTable)
      .set({ builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.SRE } })
      .where(
        and(
          eq(schema.agentsTable.id, id),
          isNull(schema.agentsTable.builtInAgentConfig),
          notDeleted(schema.agentsTable),
        ),
      );
  }
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
    systemPrompt: string | null;
  } | null> {
    const [row] = await db
      .select({
        id: schema.agentsTable.id,
        deletedAt: schema.agentsTable.deletedAt,
        latestVersion: schema.agentsTable.latestVersion,
        systemPrompt: schema.agentsTable.systemPrompt,
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
