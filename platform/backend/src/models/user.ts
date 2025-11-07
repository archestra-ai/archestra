import {
  type Action,
  ADMIN_ROLE_NAME,
  type Resource,
  type Role,
} from "@shared";
import { and, eq } from "drizzle-orm";
import { betterAuth } from "@/auth";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import RoleModel from "./role";

class User {
  static async createOrGetExistingDefaultAdminUser({
    email = config.auth.adminDefaultEmail,
    password = config.auth.adminDefaultPassword,
    role = ADMIN_ROLE_NAME,
    name = "Admin",
  }: {
    email?: string;
    password?: string;
    role?: Role;
    name?: string;
  } = {}) {
    try {
      const existing = await db
        .select()
        .from(schema.usersTable)
        .where(eq(schema.usersTable.email, email));
      if (existing.length > 0) {
        logger.info({ email }, "User already exists:");
        return existing[0];
      }

      const result = await betterAuth.api.signUpEmail({
        body: {
          email,
          password,
          name,
        },
      });
      if (result) {
        await db
          .update(schema.usersTable)
          .set({
            role,
            emailVerified: true,
          })
          .where(eq(schema.usersTable.email, email));

        logger.info({ email }, "User created successfully:");
      }
      return result.user;
    } catch (err) {
      logger.error({ err }, "Failed to create user");
    }
  }

  static async getUserById(id: string) {
    const [user] = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, id))
      .limit(1);
    return user;
  }

  static async getOrganizationId(userId: string): Promise<string | null> {
    const [userMembership] = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.userId, userId))
      .limit(1);

    return userMembership?.organizationId ?? null;
  }

  /**
   * Get all permissions for a user (helper to fetch from better-auth)
   */
  static async getUserPermissions(
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
    if (!RoleModel.isCustomRole(userRole)) {
      return RoleModel.getPredefinedRolePermissions(userRole as Role);
    }

    // Fetch custom role details
    try {
      const roles = await RoleModel.listRolesByOrganization(organizationId);
      const role = roles.find((r) => r.name === userRole);

      if (!role) {
        return {} as Record<Resource, Action[]>;
      }

      const roleDetails = await RoleModel.getRoleById(role.id, organizationId);

      if (roleDetails?.permissions) {
        return roleDetails.permissions as Record<Resource, Action[]>;
      }

      return {} as Record<Resource, Action[]>;
    } catch (_error) {
      return {} as Record<Resource, Action[]>;
    }
  }
}

export default User;
