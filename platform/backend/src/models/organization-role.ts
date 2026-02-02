import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
  type Permissions,
  type PredefinedRoleName,
  PredefinedRoleNameSchema,
  type Resource,
} from "@shared";
import { predefinedPermissionsMap } from "@shared/access-control";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { OrganizationRole } from "@/types";

const generatePredefinedRole = (
  role: PredefinedRoleName,
  organizationId: string,
): OrganizationRole => ({
  id: role,
  role: role,
  name: role,
  organizationId,
  permission: OrganizationRoleModel.getPredefinedRolePermissions(role),
  predefined: true,
  // we don't really care too much about the createdAt and updatedAt for predefined roles..
  createdAt: new Date(),
  updatedAt: new Date(),
});

class OrganizationRoleModel {
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
    logger.debug(
      "OrganizationRoleModel.validateRolePermissions: validating permissions",
    );
    const missingPermissions: string[] = [];

    for (const [resource, actions] of Object.entries(rolePermissions)) {
      const userResourceActions = userPermissions[resource as Resource] || [];

      for (const action of actions) {
        if (!userResourceActions.includes(action)) {
          missingPermissions.push(`${resource}:${action}`);
        }
      }
    }

    logger.debug(
      {
        valid: missingPermissions.length === 0,
        missingCount: missingPermissions.length,
      },
      "OrganizationRoleModel.validateRolePermissions: completed",
    );
    return {
      valid: missingPermissions.length === 0,
      missingPermissions,
    };
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
      permission: JSON.parse(result.permission),
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
      permission: JSON.parse(result.permission),
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

    const role = await OrganizationRoleModel.getByIdentifier(
      identifier,
      organizationId,
    );

    if (!role) {
      logger.debug(
        { identifier },
        "OrganizationRoleModel.getPermissions: role not found, returning empty",
      );
      return {};
    }

    logger.debug(
      { identifier },
      "OrganizationRoleModel.getPermissions: completed",
    );
    return role.permission;
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
    const predefinedRoles = [
      generatePredefinedRole(ADMIN_ROLE_NAME, organizationId),
      generatePredefinedRole(EDITOR_ROLE_NAME, organizationId),
      generatePredefinedRole(MEMBER_ROLE_NAME, organizationId),
    ];

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
          permission: JSON.parse(role.permission),
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
   * @deprecated Do not use directly. Routes should use betterAuth.api.createOrgRole() instead.
   * This method exists only for test fixtures.
   */
  static async create(): Promise<OrganizationRole> {
    throw new Error(
      "OrganizationRoleModel.create() should not be called directly. Use betterAuth.api.createOrgRole() in routes, or direct DB operations in test fixtures.",
    );
  }

  /**
   * @deprecated Do not use directly. Routes should use betterAuth.api.updateOrgRole() instead.
   * This method exists only for test fixtures.
   */
  static async update(): Promise<OrganizationRole> {
    throw new Error(
      "OrganizationRoleModel.update() should not be called directly. Use betterAuth.api.updateOrgRole() in routes, or direct DB operations in test fixtures.",
    );
  }

  /**
   * @deprecated Do not use directly. Routes should use betterAuth.api.deleteOrgRole() instead.
   * This method exists only for test fixtures.
   */
  static async delete(): Promise<boolean> {
    throw new Error(
      "OrganizationRoleModel.delete() should not be called directly. Use betterAuth.api.deleteOrgRole() in routes, or direct DB operations in test fixtures.",
    );
  }
}

export default OrganizationRoleModel;
