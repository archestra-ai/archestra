import {
  ADMIN_ROLE_NAME,
  MEMBER_ROLE_NAME,
  type Permissions,
  type PredefinedRoleName,
  PredefinedRoleNameSchema,
  predefinedPermissionsMap,
  type Resource,
} from "@shared";
import { and, eq, getTableColumns, ne, sql } from "drizzle-orm";
import { betterAuth } from "@/auth";
import db, { schema } from "@/database";
import type {
  InsertOrganizationRole,
  OrganizationRole,
  UpdateOrganizationRole,
} from "@/types";

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

  /**
   * Get a role by name and organization
   */
  static async getByName(
    roleName: string,
    organizationId: string,
  ): Promise<OrganizationRole | null> {
    // Check if it's a predefined role first
    if (OrganizationRoleModel.isPredefinedRole(roleName)) {
      return generatePredefinedRole(roleName, organizationId);
    }

    // Query custom role from database by name
    const [result] = await db
      .select({
        ...getTableColumns(schema.organizationRolesTable),
        predefined: sql<boolean>`false`,
      })
      .from(schema.organizationRolesTable)
      .where(
        and(
          eq(schema.organizationRolesTable.role, roleName),
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
    roleName: string,
    organizationId: string,
  ): Promise<Permissions> {
    if (OrganizationRoleModel.isPredefinedRole(roleName)) {
      return OrganizationRoleModel.getPredefinedRolePermissions(roleName);
    }

    const role = await OrganizationRoleModel.getByName(
      roleName,
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

  static async create(data: InsertOrganizationRole): Promise<OrganizationRole> {
    // Generate a test ID since Better Auth would normally generate this
    // This method is only used in tests - production uses betterAuth.api.createOrgRole()
    const id = crypto.randomUUID();

    const [result] = await db
      .insert(schema.organizationRolesTable)
      .values({
        id,
        ...data,
        permission: JSON.stringify(data.permission),
      })
      .returning();

    return {
      ...result,
      predefined: false,
      permission: JSON.parse(result.permission),
    };
  }

  /**
   * Update a custom role
   * In production: Uses Better Auth API with authenticated headers
   * In tests: Direct database update (when headers are empty object)
   */
  static async update(
    headers: HeadersInit,
    roleId: string,
    organizationId: string,
    data: UpdateOrganizationRole,
  ): Promise<OrganizationRole> {
    // Check if we're in a test environment (empty headers object)
    const isTest = Object.keys(headers).length === 0;

    if (isTest) {
      // Direct database update for tests
      const updateData: Record<string, unknown> = {
        updatedAt: new Date(),
      };
      if (data.name !== undefined) updateData.name = data.name;
      if (data.permission !== undefined) {
        updateData.permission = JSON.stringify(data.permission);
      }

      const [result] = await db
        .update(schema.organizationRolesTable)
        .set(updateData)
        .where(
          and(
            eq(schema.organizationRolesTable.id, roleId),
            eq(schema.organizationRolesTable.organizationId, organizationId),
          ),
        )
        .returning();

      if (!result) {
        throw new Error("Role not found");
      }

      return {
        ...result,
        permission: JSON.parse(result.permission),
        predefined: false,
      };
    }

    // Production: Use Better Auth API
    const result = await betterAuth.api.updateOrgRole({
      headers,
      body: {
        roleId,
        organizationId,
        data: {
          ...(data.name && { name: data.name }),
          ...(data.permission && { permission: data.permission }),
        },
      },
    });

    if (!result.roleData) {
      throw new Error("Role updated but data not returned");
    }

    return {
      ...result.roleData,
      updatedAt: result.roleData.updatedAt || new Date(),
      predefined: false,
    };
  }

  /**
   * Delete a custom role
   * In production: Uses Better Auth API with authenticated headers
   * In tests: Direct database delete (when headers are empty object)
   */
  static async delete(
    headers: HeadersInit,
    roleId: string,
    organizationId: string,
  ): Promise<boolean> {
    // Check if we're in a test environment (empty headers object)
    const isTest = Object.keys(headers).length === 0;

    if (isTest) {
      // Direct database delete for tests
      const result = await db
        .delete(schema.organizationRolesTable)
        .where(
          and(
            eq(schema.organizationRolesTable.id, roleId),
            eq(schema.organizationRolesTable.organizationId, organizationId),
          ),
        )
        .returning();

      return result.length > 0;
    }

    // Production: Use Better Auth API
    await betterAuth.api.deleteOrgRole({
      headers,
      body: {
        roleId,
        organizationId,
      },
    });

    return true;
  }
}

export default OrganizationRoleModel;
