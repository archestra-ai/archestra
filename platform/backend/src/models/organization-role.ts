import {
  ADMIN_ROLE_NAME,
  MEMBER_ROLE_NAME,
  type Permissions,
  type PredefinedRoleName,
  PredefinedRoleNameSchema,
  predefinedPermissionsMap,
  type Resource,
} from "@shared";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import db, { schema } from "@/database";
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
    return PredefinedRoleNameSchema.safeParse(roleName).success;
  }

  /**
   * Get permissions for a predefined role
   */
  static getPredefinedRolePermissions(
    roleName: PredefinedRoleName,
  ): Permissions {
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
    const missingPermissions: string[] = [];

    for (const [resource, actions] of Object.entries(rolePermissions)) {
      const userResourceActions = userPermissions[resource as Resource] || [];

      for (const action of actions) {
        if (!userResourceActions.includes(action)) {
          missingPermissions.push(`${resource}:${action}`);
        }
      }
    }

    return {
      valid: missingPermissions.length === 0,
      missingPermissions,
    };
  }

  static async canDelete(
    roleId: string,
    organizationId: string,
  ): Promise<{ canDelete: boolean; reason?: string }> {
    // Check if it's a predefined role by ID
    const role = await OrganizationRoleModel.getById(roleId, organizationId);

    if (!role) {
      return { canDelete: false, reason: "Role not found" };
    }

    // Check if it's a predefined role
    if (OrganizationRoleModel.isPredefinedRole(role.role)) {
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
      return {
        canDelete: false,
        reason: "Cannot delete role that is used in pending invitations",
      };
    }

    return { canDelete: true };
  }

  /**
   * Get a role by identifier, e.g. "member" (buit-in) or "reader" (custom)
   */
  static async getByIdentifier(
    identifier: string,
    organizationId: string,
  ): Promise<OrganizationRole | null> {
    // Check if it's a predefined role first
    if (OrganizationRoleModel.isPredefinedRole(identifier)) {
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
      return null;
    }

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
    // Check if it's a predefined role first
    if (OrganizationRoleModel.isPredefinedRole(roleId)) {
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
      return null;
    }

    return {
      ...result,
      permission: JSON.parse(result.permission),
    };
  }

  static async getPermissions(
    identifier: string,
    organizationId: string,
  ): Promise<Permissions> {
    if (OrganizationRoleModel.isPredefinedRole(identifier)) {
      return OrganizationRoleModel.getPredefinedRolePermissions(identifier);
    }

    const role = await OrganizationRoleModel.getByIdentifier(
      identifier,
      organizationId,
    );

    if (!role) {
      return {};
    }

    return role.permission;
  }

  /**
   * List all roles for an organization (including predefined)
   */
  static async getAll(
    organizationId: string,
  ): Promise<Array<OrganizationRole>> {
    const predefinedRoles = [
      generatePredefinedRole(ADMIN_ROLE_NAME, organizationId),
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

      return [
        ...predefinedRoles,
        ...customRoles.map((role) => ({
          ...role,
          permission: JSON.parse(role.permission),
        })),
      ];
    } catch (_error) {
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
