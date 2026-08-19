import {
  PredefinedRoleNameSchema,
  ROLE_RESOURCE_KINDS,
  type RoleResourceAccess,
  type RoleResourceAccessInput,
  type RoleResourceKind,
  UNRESTRICTED_ROLE_RESOURCE_ACCESS,
  unionAllowLists,
} from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";

/**
 * Per-role allow-lists for the built-in catalogs. A role with no row is
 * unrestricted, so the common case costs one indexed lookup that misses.
 */
class RoleResourceAccessModel {
  /** The allow-lists a single role carries, defaulting to unrestricted. */
  static async getForRole(params: {
    organizationId: string;
    role: string;
  }): Promise<RoleResourceAccess> {
    const [row] = await db
      .select(SELECTED_COLUMNS)
      .from(schema.roleResourceAccessTable)
      .where(
        and(
          eq(
            schema.roleResourceAccessTable.organizationId,
            params.organizationId,
          ),
          eq(schema.roleResourceAccessTable.role, params.role),
        ),
      )
      .limit(1);
    return row ? toAccess(row) : { ...UNRESTRICTED_ROLE_RESOURCE_ACCESS };
  }

  /** Allow-lists keyed by role identifier, for the roles that carry any. */
  static async getForOrganization(
    organizationId: string,
  ): Promise<Record<string, RoleResourceAccess>> {
    const rows = await db
      .select({ role: schema.roleResourceAccessTable.role, ...SELECTED_COLUMNS })
      .from(schema.roleResourceAccessTable)
      .where(
        eq(schema.roleResourceAccessTable.organizationId, organizationId),
      );
    const byRole: Record<string, RoleResourceAccess> = {};
    for (const row of rows) {
      byRole[row.role] = toAccess(row);
    }
    return byRole;
  }

  /**
   * What the organization as a whole permits: the union across every role that
   * exists in it, where one unrestricted role makes the union unrestricted.
   *
   * For the decisions that have no user to resolve against — a ChatOps bot
   * deciding whether to listen at all, the inbound email webhook. A role with
   * no stored row is unrestricted, which is what keeps a newly created role
   * from being silently ignored here.
   *
   * Pass `null` to resolve the deployment's organization, for callers that
   * start before any request.
   */
  static async getOrganizationUnion(
    organizationId: string | null,
  ): Promise<RoleResourceAccess> {
    const resolvedId =
      organizationId ?? (await resolveDeploymentOrganizationId());
    if (!resolvedId) return { ...UNRESTRICTED_ROLE_RESOURCE_ACCESS };

    const [rows, customRoles] = await Promise.all([
      db
        .select({
          role: schema.roleResourceAccessTable.role,
          ...SELECTED_COLUMNS,
        })
        .from(schema.roleResourceAccessTable)
        .where(eq(schema.roleResourceAccessTable.organizationId, resolvedId)),
      db
        .select({ role: schema.organizationRolesTable.role })
        .from(schema.organizationRolesTable)
        .where(eq(schema.organizationRolesTable.organizationId, resolvedId)),
    ]);

    const allRoles = new Set<string>([
      ...PREDEFINED_ROLE_NAMES,
      ...customRoles.map((row) => row.role),
    ]);
    const restrictedByRole = new Map(rows.map((row) => [row.role, row]));

    const union = {} as RoleResourceAccess;
    for (const kind of ROLE_RESOURCE_KINDS) {
      // A role with no row (or no list for this kind) is unrestricted, so it
      // enters the union as null and collapses the whole union.
      const lists = [...allRoles].map(
        (role) => restrictedByRole.get(role)?.[kind] ?? null,
      );
      union[kind] = unionAllowLists(lists);
    }
    return union;
  }

  /**
   * Write the allow-lists for one role. Omitted kinds keep whatever the role
   * already had; an explicit `null` lifts that kind's restriction.
   */
  static async upsert(params: {
    organizationId: string;
    role: string;
    access: RoleResourceAccessInput;
  }): Promise<RoleResourceAccess> {
    const { organizationId, role, access } = params;
    const current = await RoleResourceAccessModel.getForRole({
      organizationId,
      role,
    });
    const next = { ...current } as RoleResourceAccess;
    for (const kind of ROLE_RESOURCE_KINDS) {
      if (kind in access) next[kind] = access[kind] ?? null;
    }

    // Every kind unrestricted again: drop the row rather than storing four
    // nulls, so "no row" stays the single representation of "unrestricted".
    if (ROLE_RESOURCE_KINDS.every((kind) => next[kind] === null)) {
      await RoleResourceAccessModel.deleteForRole({ organizationId, role });
      return next;
    }

    logger.debug(
      { organizationId, role },
      "RoleResourceAccessModel.upsert: storing role resource access",
    );
    await db
      .insert(schema.roleResourceAccessTable)
      .values({ organizationId, role, ...next })
      .onConflictDoUpdate({
        target: [
          schema.roleResourceAccessTable.organizationId,
          schema.roleResourceAccessTable.role,
        ],
        set: { ...next, updatedAt: new Date() },
      });
    return next;
  }

  static async deleteForRole(params: {
    organizationId: string;
    role: string;
  }): Promise<void> {
    await db
      .delete(schema.roleResourceAccessTable)
      .where(
        and(
          eq(
            schema.roleResourceAccessTable.organizationId,
            params.organizationId,
          ),
          eq(schema.roleResourceAccessTable.role, params.role),
        ),
      );
  }
}

export default RoleResourceAccessModel;

// ===================================================================
// Internal
// ===================================================================

const PREDEFINED_ROLE_NAMES = Object.values(PredefinedRoleNameSchema.enum);

const SELECTED_COLUMNS = {
  modelProviders: schema.roleResourceAccessTable.modelProviders,
  knowledgeConnectors: schema.roleResourceAccessTable.knowledgeConnectors,
  messagingChannels: schema.roleResourceAccessTable.messagingChannels,
  connectClients: schema.roleResourceAccessTable.connectClients,
};

function toAccess(row: Record<RoleResourceKind, string[] | null>) {
  return {
    modelProviders: row.modelProviders ?? null,
    knowledgeConnectors: row.knowledgeConnectors ?? null,
    messagingChannels: row.messagingChannels ?? null,
    connectClients: row.connectClients ?? null,
  };
}

/**
 * Single-tenant deployments have exactly one organization, and the callers
 * with no request context (ChatOps startup, the inbound email webhook) rely on
 * that to resolve one.
 */
async function resolveDeploymentOrganizationId(): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.organizationsTable.id })
    .from(schema.organizationsTable)
    .limit(1);
  return row?.id ?? null;
}
