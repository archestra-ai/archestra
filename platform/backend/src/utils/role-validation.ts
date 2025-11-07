import type { Action, Resource, Role } from "@shared";
import {
  ADMIN_ROLE_NAME,
  getPredefinedRolePermissions,
  isCustomRole,
  MEMBER_ROLE_NAME,
} from "@shared";
import { and, eq } from "drizzle-orm";
import { betterAuth } from "@/auth";
import db, { schema } from "@/database";

/**
 * Validate that permissions being granted are a subset of user's permissions
 */
export function validateRolePermissions(
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

/**
 * Check if a role can be deleted (not in use, not predefined)
 */
export async function canDeleteRole(
  roleId: string,
  organizationId: string,
): Promise<{ canDelete: boolean; reason?: string }> {
  // Check if it's a predefined role by ID
  const role = await getRoleById(roleId, organizationId);

  if (!role) {
    return { canDelete: false, reason: "Role not found" };
  }

  // Check if it's a predefined role (admin or member)
  if (!isCustomRole(role.name)) {
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
export async function isRoleNameUnique(
  name: string,
  organizationId: string,
  excludeRoleId?: string,
): Promise<boolean> {
  // Check predefined roles
  if (!isCustomRole(name)) {
    return false; // admin and member are reserved
  }

  // Check if name is already used by another custom role in this organization
  try {
    const existingRoles = await listRolesByOrganization(organizationId);
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
export async function getRoleById(
  roleId: string,
  organizationId: string,
): Promise<{ id: string; name: string; organizationId: string } | null> {
  try {
    const result = await betterAuth.api.getRole({
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
export async function listRolesByOrganization(
  organizationId: string,
): Promise<Array<{ id: string; name: string; organizationId: string }>> {
  const predefinedRoles = [
    { id: ADMIN_ROLE_NAME, name: ADMIN_ROLE_NAME, organizationId },
    { id: MEMBER_ROLE_NAME, name: MEMBER_ROLE_NAME, organizationId },
  ];

  try {
    const result = await betterAuth.api.listRoles({
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

/**
 * Get member count for a role
 */
export async function getMemberCountForRole(
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
 * Get all permissions for a user (helper to fetch from better-auth)
 */
export async function getUserPermissions(
  userId: string,
  organizationId: string,
): Promise<Record<Resource, Action[]>> {
  // Get user's member record to find their role
  const memberRecord = await db
    .select()
    .from(schema.member)
    .where(
      and(
        eq(schema.member.userId, userId),
        eq(schema.member.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!memberRecord[0]) {
    return {} as Record<Resource, Action[]>;
  }

  const userRole = memberRecord[0].role;

  // If it's a predefined role, return the static permissions
  if (!isCustomRole(userRole)) {
    return getPredefinedRolePermissions(userRole as Role);
  }

  // For custom roles, fetch from better-auth
  try {
    const roles = await listRolesByOrganization(organizationId);
    const role = roles.find((r) => r.name === userRole);

    if (!role) {
      return {} as Record<Resource, Action[]>;
    }

    const roleDetails = await betterAuth.api.getRole({
      body: {
        roleId: role.id,
        organizationId,
      },
    });

    if (roleDetails?.data?.permissions) {
      return roleDetails.data.permissions as Record<Resource, Action[]>;
    }

    return {} as Record<Resource, Action[]>;
  } catch (error) {
    return {} as Record<Resource, Action[]>;
  }
}
