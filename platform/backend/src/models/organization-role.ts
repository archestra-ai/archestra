import {
  type Action,
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
  OWNER_ROLE_NAME,
  type Permissions,
  PLATFORM_ADMIN_ROLE_NAME,
  type PredefinedRoleName,
  PredefinedRoleNameSchema,
  type Resource,
  roleDescriptions,
  roleDisplayNames,
  TimeInMs,
} from "@archestra/shared";
import {
  allAvailableActions,
  findUngrantablePermissions,
  predefinedPermissionsMap,
} from "@archestra/shared/access-control";
import { and, eq, getTableColumns, ilike, sql } from "drizzle-orm";
import { LRUCacheManager } from "@/cache-manager";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { OrganizationRole } from "@/types";

const ROLE_PERMISSIONS_CACHE_TTL_MS = 5 * TimeInMs.Minute;
const rolePermissionsCache = new LRUCacheManager<Permissions>({
  maxSize: 1_000,
  defaultTtl: ROLE_PERMISSIONS_CACHE_TTL_MS,
});

const generatePredefinedRole = (
  role: PredefinedRoleName,
  organizationId: string,
): OrganizationRole => ({
  id: role,
  role: role,
  name: roleDisplayNames[role],
  description: roleDescriptions[role],
  organizationId,
  permission: OrganizationRoleModel.getPredefinedRolePermissions(role),
  predefined: true,
  // we don't really care too much about the createdAt and updatedAt for predefined roles..
  createdAt: new Date(),
  updatedAt: new Date(),
});

class OrganizationRoleModel {
  static sanitizePermissions(value: unknown): Permissions {
    const parsedPermissions = parseRolePermissionsValue(value);
    if (!parsedPermissions) {
      return {};
    }

    const sanitizedPermissions: Permissions = {};

    for (const [resource, actions] of Object.entries(parsedPermissions)) {
      if (!(resource in allAvailableActions) || !Array.isArray(actions)) {
        continue;
      }

      const allowedActions = allAvailableActions[resource as Resource];
      const validActions = actions.filter(
        (action): action is Action =>
          typeof action === "string" &&
          allowedActions.includes(action as Action),
      );

      if (validActions.length > 0) {
        sanitizedPermissions[resource as Resource] = validActions;
      }
    }

    return sanitizedPermissions;
  }

  static invalidatePermissionsCacheForRole(
    organizationId: string,
    identifier: string,
  ) {
    rolePermissionsCache.delete(
      OrganizationRoleModel.getPermissionsCacheKey(organizationId, identifier),
    );
  }

  /**
   * Check if a role is a predefined role (not a custom one)
   */
  static isPredefinedRole(roleName: string): roleName is PredefinedRoleName {
    // logger.debug(
    //   { roleName },
    //   "OrganizationRoleModel.isPredefinedRole: checking",
    // );
    const result = PredefinedRoleNameSchema.safeParse(roleName).success;
    // logger.debug(
    //   { roleName, isPredefined: result },
    //   "OrganizationRoleModel.isPredefinedRole: completed",
    // );
    return result;
  }

  /**
   * Get permissions for a predefined role
   */
  static getPredefinedRolePermissions(
    roleName: PredefinedRoleName,
  ): Permissions {
    // logger.debug(
    //   { roleName },
    //   "OrganizationRoleModel.getPredefinedRolePermissions: fetching",
    // );
    return predefinedPermissionsMap[roleName];
  }

  // TODO: add later...
  // /**
  //  * Get member count for a role
  //  */
  // static async getMemberCount(
  //   roleName: string,
  //   organizationId: string,
  // ): Promise<number> {
  //   const members = await db
  //     .select()
  //     .from(schema.member)
  //     .where(
  //       and(
  //         eq(schema.member.organizationId, organizationId),
  //         eq(schema.member.role, roleName),
  //       ),
  //     );

  //   return members.length;
  // }

  /**
   * Validate that permissions being granted are a subset of user's permissions
   */
  static validateRolePermissions(
    userPermissions: Permissions,
    rolePermissions: Permissions,
  ): { valid: boolean; missingPermissions: string[] } {
    const missingPermissions = findUngrantablePermissions(
      userPermissions,
      rolePermissions,
    );
    return { valid: missingPermissions.length === 0, missingPermissions };
  }

  /**
   * Check if a role can be deleted
   */
  static async canDelete(
    roleId: string,
    organizationId: string,
  ): Promise<{ canDelete: boolean; reason?: string }> {
    logger.debug(
      { roleId, organizationId },
      "OrganizationRoleModel.canDelete: checking",
    );
    // Check if it's a predefined role by ID
    const role = await OrganizationRoleModel.getById(roleId, organizationId);

    if (!role) {
      logger.debug(
        { roleId },
        "OrganizationRoleModel.canDelete: role not found",
      );
      return { canDelete: false, reason: "Role not found" };
    }

    // Check if it's a predefined role
    if (OrganizationRoleModel.isPredefinedRole(role.role)) {
      logger.debug(
        { roleId },
        "OrganizationRoleModel.canDelete: cannot delete predefined role",
      );
      return { canDelete: false, reason: "Cannot delete predefined roles" };
    }

    // Check if role is currently assigned to any members
    const membersWithRole = await db
      .select()
      .from(schema.membersTable)
      .where(
        and(
          eq(schema.membersTable.organizationId, organizationId),
          eq(schema.membersTable.role, role.role),
        ),
      )
      .limit(1);

    if (membersWithRole.length > 0) {
      logger.debug(
        { roleId },
        "OrganizationRoleModel.canDelete: role assigned to members",
      );
      return {
        canDelete: false,
        reason: "Cannot delete role that is currently assigned to members",
      };
    }

    // Check if role is used in any pending invitations
    const invitationsWithRole = await db
      .select()
      .from(schema.invitationsTable)
      .where(
        and(
          eq(schema.invitationsTable.organizationId, organizationId),
          eq(schema.invitationsTable.role, role.role),
          eq(schema.invitationsTable.status, "pending"),
        ),
      )
      .limit(1);

    if (invitationsWithRole.length > 0) {
      logger.debug(
        { roleId },
        "OrganizationRoleModel.canDelete: role used in pending invitations",
      );
      return {
        canDelete: false,
        reason: "Cannot delete role that is used in pending invitations",
      };
    }

    logger.debug({ roleId }, "OrganizationRoleModel.canDelete: can delete");
    return { canDelete: true };
  }

  /**
   * Get a role by identifier, e.g. "member" (buit-in) or "reader" (custom)
   */
  static async getByIdentifier(
    identifier: string,
    organizationId: string,
  ): Promise<OrganizationRole | null> {
    logger.debug(
      { identifier, organizationId },
      "OrganizationRoleModel.getByIdentifier: fetching",
    );
    // Check if it's a predefined role first
    if (OrganizationRoleModel.isPredefinedRole(identifier)) {
      logger.debug(
        { identifier },
        "OrganizationRoleModel.getByIdentifier: returning predefined role",
      );
      return generatePredefinedRole(identifier, organizationId);
    }

    const [result] = await db
      .select({
        ...getTableColumns(schema.organizationRolesTable),
        predefined: sql<boolean>`false`,
      })
      .from(schema.organizationRolesTable)
      .where(
        and(
          eq(schema.organizationRolesTable.role, identifier),
          eq(schema.organizationRolesTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!result) {
      logger.debug(
        { identifier },
        "OrganizationRoleModel.getByIdentifier: not found",
      );
      return null;
    }

    logger.debug(
      { identifier },
      "OrganizationRoleModel.getByIdentifier: completed",
    );
    return {
      ...result,
      permission: OrganizationRoleModel.sanitizePermissions(result.permission),
    };
  }

  /**
   * Get a role by ID and organization
   */
  static async getById(
    roleId: string,
    organizationId: string,
  ): Promise<OrganizationRole | null> {
    logger.debug(
      { roleId, organizationId },
      "OrganizationRoleModel.getById: fetching",
    );
    // Check if it's a predefined role first
    if (OrganizationRoleModel.isPredefinedRole(roleId)) {
      logger.debug(
        { roleId },
        "OrganizationRoleModel.getById: returning predefined role",
      );
      return generatePredefinedRole(roleId, organizationId);
    }

    // Query custom role from database by ID
    const [result] = await db
      .select({
        ...getTableColumns(schema.organizationRolesTable),
        predefined: sql<boolean>`false`,
      })
      .from(schema.organizationRolesTable)
      .where(
        and(
          eq(schema.organizationRolesTable.id, roleId),
          eq(schema.organizationRolesTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!result) {
      logger.debug({ roleId }, "OrganizationRoleModel.getById: not found");
      return null;
    }

    logger.debug({ roleId }, "OrganizationRoleModel.getById: completed");
    return {
      ...result,
      permission: OrganizationRoleModel.sanitizePermissions(result.permission),
    };
  }

  /**
   * Get permissions for a role
   */
  static async getPermissions(
    identifier: string,
    organizationId: string,
  ): Promise<Permissions> {
    // logger.debug(
    //   { identifier, organizationId },
    //   "OrganizationRoleModel.getPermissions: fetching",
    // );
    if (OrganizationRoleModel.isPredefinedRole(identifier)) {
      return OrganizationRoleModel.getPredefinedRolePermissions(identifier);
    }

    const cacheKey = OrganizationRoleModel.getPermissionsCacheKey(
      organizationId,
      identifier,
    );
    const cachedPermissions = rolePermissionsCache.get(cacheKey);
    if (cachedPermissions) {
      return cachedPermissions;
    }

    const role = await OrganizationRoleModel.getByIdentifier(
      identifier,
      organizationId,
    );

    if (!role) {
      // better-auth assigns "owner" to the organization creator by default.
      // That identifier is not one of our predefined roles and has no
      // organization_roles row, so RBAC resolved to {} and impersonation
      // (among everything else) failed for those members.
      if (identifier === OWNER_ROLE_NAME) {
        return OrganizationRoleModel.getPredefinedRolePermissions(
          ADMIN_ROLE_NAME,
        );
      }
      logger.debug(
        { identifier },
        "OrganizationRoleModel.getPermissions: role not found, returning empty",
      );
      return {};
    }

    rolePermissionsCache.set(cacheKey, role.permission);

    logger.debug(
      { identifier },
      "OrganizationRoleModel.getPermissions: completed",
    );
    return role.permission;
  }

  /**
   * List only predefined roles for an organization
   */
  static getPredefinedOnly(organizationId: string): Array<OrganizationRole> {
    return [
      generatePredefinedRole(ADMIN_ROLE_NAME, organizationId),
      generatePredefinedRole(PLATFORM_ADMIN_ROLE_NAME, organizationId),
      generatePredefinedRole(EDITOR_ROLE_NAME, organizationId),
      generatePredefinedRole(MEMBER_ROLE_NAME, organizationId),
    ];
  }

  /**
   * List all roles for an organization (including predefined)
   */
  static async getAll(
    organizationId: string,
  ): Promise<Array<OrganizationRole>> {
    logger.debug(
      { organizationId },
      "OrganizationRoleModel.getAll: fetching roles",
    );
    const predefinedRoles =
      OrganizationRoleModel.getPredefinedOnly(organizationId);

    try {
      const customRoles = await db
        .select({
          ...getTableColumns(schema.organizationRolesTable),
          predefined: sql<boolean>`false`,
        })
        .from(schema.organizationRolesTable)
        .where(
          eq(schema.organizationRolesTable.organizationId, organizationId),
        );

      logger.debug(
        {
          organizationId,
          predefinedCount: predefinedRoles.length,
          customCount: customRoles.length,
        },
        "OrganizationRoleModel.getAll: completed",
      );
      return [
        ...predefinedRoles,
        ...customRoles.map((role) => ({
          ...role,
          permission: OrganizationRoleModel.sanitizePermissions(
            role.permission,
          ),
        })),
      ];
    } catch (_error) {
      logger.debug(
        { organizationId },
        "OrganizationRoleModel.getAll: error fetching custom roles, returning predefined only",
      );
      // Return predefined roles as fallback
      return predefinedRoles;
    }
  }

  /**
   * List roles for an organization with pagination and optional name filtering.
   * Predefined roles are always ordered first.
   */
  static async getAllPaginated(params: {
    organizationId: string;
    limit: number;
    offset: number;
    name?: string;
    isAdmin: boolean;
  }): Promise<{ data: OrganizationRole[]; total: number }> {
    const { organizationId, limit, offset, name, isAdmin } = params;

    const normalizedSearch = name?.trim().toLowerCase();
    const predefinedRoles = OrganizationRoleModel.getPredefinedOnly(
      organizationId,
    ).filter((role) => {
      if (!normalizedSearch) return true;
      return role.name.toLowerCase().includes(normalizedSearch);
    });

    if (!isAdmin) {
      const pagedPredefined = predefinedRoles.slice(offset, offset + limit);
      return {
        data: pagedPredefined,
        total: predefinedRoles.length,
      };
    }

    const customFilters = [
      eq(schema.organizationRolesTable.organizationId, organizationId),
      ...(normalizedSearch
        ? [ilike(schema.organizationRolesTable.name, `%${normalizedSearch}%`)]
        : []),
    ];

    const [{ count: customTotalRaw = 0 }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.organizationRolesTable)
      .where(and(...customFilters));

    const customTotal = Number(customTotalRaw);

    const predefinedCount = predefinedRoles.length;
    const total = predefinedCount + customTotal;

    const takeFromPredefined =
      offset < predefinedCount
        ? predefinedRoles.slice(offset, offset + limit)
        : [];
    const remainingLimit = Math.max(0, limit - takeFromPredefined.length);
    const customOffset =
      offset < predefinedCount ? 0 : Math.max(0, offset - predefinedCount);

    const customRoles =
      remainingLimit > 0
        ? await db
            .select({
              ...getTableColumns(schema.organizationRolesTable),
              predefined: sql<boolean>`false`,
            })
            .from(schema.organizationRolesTable)
            .where(and(...customFilters))
            .orderBy(schema.organizationRolesTable.name)
            .limit(remainingLimit)
            .offset(customOffset)
        : [];

    return {
      data: [
        ...takeFromPredefined,
        ...customRoles.map((role) => ({
          ...role,
          permission: OrganizationRoleModel.sanitizePermissions(
            role.permission,
          ),
        })),
      ],
      total,
    };
  }

  /**
   * Create a custom role.
   *
   * Authorization (the no-privilege-escalation rule), the enterprise licence
   * gate, and name validation belong to the route; this only writes the row.
   * Permissions are sanitized on the way in so the stored set never carries a
   * resource or action outside the permission universe — reads sanitize too,
   * so an unsanitized write would silently vanish on the way back out.
   */
  static async create(params: {
    organizationId: string;
    role: string;
    name: string;
    description?: string | null;
    permission: Permissions;
  }): Promise<OrganizationRole> {
    const permission = OrganizationRoleModel.sanitizePermissions(
      params.permission,
    );
    logger.debug(
      { role: params.role, organizationId: params.organizationId },
      "OrganizationRoleModel.create: inserting",
    );

    const [result] = await db
      .insert(schema.organizationRolesTable)
      .values({
        id: crypto.randomUUID(),
        organizationId: params.organizationId,
        role: params.role,
        name: params.name,
        description: params.description ?? null,
        permission: JSON.stringify(permission),
      })
      .returning();

    return { ...result, permission, predefined: false };
  }

  /**
   * Update a custom role's display name, description, and/or permissions.
   * The `role` identifier is immutable. Returns null when no row matches.
   */
  static async update(params: {
    id: string;
    organizationId: string;
    name?: string;
    description?: string | null;
    permission?: Permissions;
  }): Promise<OrganizationRole | null> {
    const updates: Partial<typeof schema.organizationRolesTable.$inferInsert> =
      {};
    if (params.name !== undefined) updates.name = params.name;
    if (params.description !== undefined)
      updates.description = params.description;
    if (params.permission !== undefined) {
      updates.permission = JSON.stringify(
        OrganizationRoleModel.sanitizePermissions(params.permission),
      );
    }

    if (Object.keys(updates).length === 0) {
      return OrganizationRoleModel.getById(params.id, params.organizationId);
    }

    logger.debug(
      { roleId: params.id, organizationId: params.organizationId },
      "OrganizationRoleModel.update: updating",
    );

    const [result] = await db
      .update(schema.organizationRolesTable)
      .set(updates)
      .where(
        and(
          eq(schema.organizationRolesTable.id, params.id),
          eq(
            schema.organizationRolesTable.organizationId,
            params.organizationId,
          ),
        ),
      )
      .returning();

    if (!result) return null;

    return {
      ...result,
      permission: OrganizationRoleModel.sanitizePermissions(result.permission),
      predefined: false,
    };
  }

  /**
   * Delete a custom role. Returns false when no row matched.
   */
  static async delete(id: string, organizationId: string): Promise<boolean> {
    logger.debug(
      { roleId: id, organizationId },
      "OrganizationRoleModel.delete: deleting",
    );
    const deleted = await db
      .delete(schema.organizationRolesTable)
      .where(
        and(
          eq(schema.organizationRolesTable.id, id),
          eq(schema.organizationRolesTable.organizationId, organizationId),
        ),
      )
      .returning({ id: schema.organizationRolesTable.id });

    return deleted.length > 0;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const role = await OrganizationRoleModel.getById(id, organizationId);
    if (!role) return null;

    return {
      id: role.id,
      organizationId: role.organizationId,
      role: role.role,
      name: role.name,
      description: role.description ?? null,
      permission: role.permission,
      predefined: role.predefined,
      createdAt: role.createdAt?.toISOString() ?? null,
    };
  }

  private static getPermissionsCacheKey(
    organizationId: string,
    identifier: string,
  ): string {
    return `${organizationId}:${identifier}`;
  }
}

export default OrganizationRoleModel;

function parseRolePermissionsValue(
  value: unknown,
): Record<string, unknown> | null {
  if (typeof value !== "string") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  try {
    const parsedValue = JSON.parse(value) as unknown;
    if (
      !parsedValue ||
      typeof parsedValue !== "object" ||
      Array.isArray(parsedValue)
    ) {
      return null;
    }

    return parsedValue as Record<string, unknown>;
  } catch (error) {
    logger.warn(
      { error, permission: value },
      "Failed to parse organization role permissions JSON",
    );
    return null;
  }
}
