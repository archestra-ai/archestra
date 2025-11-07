import type { Action, Resource, Role } from "@shared";
import {
  ADMIN_ROLE_NAME,
  ALL_PREDEFINED_ROLES,
  allAvailableActions,
  MEMBER_ROLE_NAME,
  memberRole,
} from "@shared";
import { and, eq } from "drizzle-orm";
import { betterAuth } from "@/auth";
import db, { schema } from "@/database";

class RoleModel {
  /**
   * Check if a role is a custom role (not predefined)
   */
  static isCustomRole(role: Role) {
    return !ALL_PREDEFINED_ROLES.includes(role);
  }

  /**
   * Get permissions for a predefined role
   */
  static getPredefinedRolePermissions(role: Role): Record<Resource, Action[]> {
    if (role === ADMIN_ROLE_NAME) {
      return allAvailableActions;
    }
    return memberRole.statements as Record<Resource, Action[]>;
  }

  /**
   * Get member count for a role
   */
  static async getMemberCountForRole(
    roleName: string,
    organizationId: string,
  ): Promise<number> {
    const members = await db
      .select()
      .from(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, organizationId),
          eq(schema.member.role, roleName),
        ),
      );

    return members.length;
  }

  /**
   * Validate that permissions being granted are a subset of user's permissions
   */
  static validateRolePermissions(
    userPermissions: Record<Resource, Action[]>,
    rolePermissions: Record<string, Action[]>,
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

  static async canDeleteRole(
    roleId: string,
    organizationId: string,
  ): Promise<{ canDelete: boolean; reason?: string }> {
    // Check if it's a predefined role by ID
    const role = await RoleModel.getRoleById(roleId, organizationId);

    if (!role) {
      return { canDelete: false, reason: "Role not found" };
    }

    // Check if it's a predefined role (admin or member)
    if (!RoleModel.isCustomRole(role.name)) {
      return {
        canDelete: false,
        reason: "Cannot delete predefined roles (admin, member)",
      };
    }

    // Check if role is currently assigned to any members
    const membersWithRole = await db
      .select()
      .from(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, organizationId),
          eq(schema.member.role, role.name),
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
      .from(schema.invitation)
      .where(
        and(
          eq(schema.invitation.organizationId, organizationId),
          eq(schema.invitation.role, role.name),
          eq(schema.invitation.status, "pending"),
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
   * Validate role name uniqueness within organization
   */
  static async isRoleNameUnique(
    name: string,
    organizationId: string,
    excludeRoleId?: string,
  ): Promise<boolean> {
    // Check predefined roles
    if (!RoleModel.isCustomRole(name)) {
      return false; // admin and member are reserved
    }

    // Check if name is already used by another custom role in this organization
    try {
      const existingRoles =
        await RoleModel.listRolesByOrganization(organizationId);
      const duplicate = existingRoles.find(
        (role) =>
          role.name.toLowerCase() === name.toLowerCase() &&
          role.id !== excludeRoleId,
      );

      return !duplicate;
    } catch (_error) {
      // If we can't fetch roles, assume it's not unique to be safe
      return false;
    }
  }

  /**
   * Get a role by ID and organization
   */
  static async getRoleById(
    roleId: string,
    organizationId: string,
  ): Promise<{ id: string; name: string; organizationId: string } | null> {
    try {
      const result = await betterAuth.api.getOrgRole({
        body: {
          roleId,
          organizationId,
        },
      });

      if (result?.data) {
        return {
          id: result.data.id,
          name: result.data.name,
          organizationId: result.data.organizationId,
        };
      }

      return null;
    } catch (_error) {
      return null;
    }
  }

  /**
   * List all roles for an organization (including predefined)
   */
  static async listRolesByOrganization(
    organizationId: string,
  ): Promise<Array<{ id: string; name: string; organizationId: string }>> {
    const predefinedRoles = [
      { id: ADMIN_ROLE_NAME, name: ADMIN_ROLE_NAME, organizationId },
      { id: MEMBER_ROLE_NAME, name: MEMBER_ROLE_NAME, organizationId },
    ];

    try {
      const result = await betterAuth.api.listOrgRoles({
        query: {
          organizationId,
        },
      });

      if (result?.data && Array.isArray(result.data)) {
        return result.data.map((role: any) => ({
          id: role.id,
          name: role.name,
          organizationId: role.organizationId,
        }));
      }

      // If no custom roles, return predefined ones
      return predefinedRoles;
    } catch (_error) {
      // Return predefined roles as fallback
      return predefinedRoles;
    }
  }

  static async create(
    roleName: string,
    permissions: Record<string, Action[]>,
    organizationId: string,
  ) {
    try {
      const result = await betterAuth.api.createOrgRole({
        body: {
          role: roleName,
          permissions,
          organizationId,
        },
      });
      return result?.data;
    } catch (_error) {
      return null;
    }
  }

  static async update(
    roleId: string,
    roleName: string,
    permissions: Record<string, Action[]>,
    organizationId: string,
  ) {
    try {
      const result = await betterAuth.api.updateOrgRole({
        body: {
          roleId,
          role: roleName,
          permissions,
          organizationId,
        },
      });
      return result?.data;
    } catch (_error) {
      return null;
    }
  }

  static async delete(roleId: string, organizationId: string) {
    try {
      const result = await betterAuth.api.deleteOrgRole({
        body: {
          roleId,
          organizationId,
        },
      });
      return result?.data?.success;
    } catch (_error) {
      return false;
    }
  }
}

export default RoleModel;
