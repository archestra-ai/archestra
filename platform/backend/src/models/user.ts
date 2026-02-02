import {
  ADMIN_ROLE_NAME,
  DEFAULT_ADMIN_EMAIL,
  type Permissions,
  type PredefinedRoleName,
} from "@shared";
import { eq, getTableColumns } from "drizzle-orm";
import { betterAuth } from "@/auth";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { UpdateUser } from "@/types";
import MemberModel from "./member";
import OrganizationRoleModel from "./organization-role";

class UserModel {
  static async createOrGetExistingDefaultAdminUser({
    email = config.auth.adminDefaultEmail,
    password = config.auth.adminDefaultPassword,
    role = ADMIN_ROLE_NAME,
    name = "Admin",
  }: {
    email?: string;
    password?: string;
    role?: PredefinedRoleName;
    name?: string;
  } = {}) {
    logger.debug(
      { email, role, name },
      "UserModel.createOrGetExistingDefaultAdminUser: starting",
    );
    try {
      const existing = await db
        .select()
        .from(schema.usersTable)
        .where(eq(schema.usersTable.email, email));
      if (existing.length > 0) {
        logger.debug(
          { email },
          "UserModel.createOrGetExistingDefaultAdminUser: user already exists",
        );
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

        logger.debug(
          { email },
          "UserModel.createOrGetExistingDefaultAdminUser: user created successfully",
        );
      }
      return result.user;
    } catch (err) {
      logger.error(
        { err },
        "UserModel.createOrGetExistingDefaultAdminUser: failed to create user",
      );
    }
  }

  /**
   * Get a user by ID with their organization membership
   */
  static async getById(id: string) {
    logger.debug("UserModel.getById: fetching user");
    const [user] = await db
      .select({
        ...getTableColumns(schema.usersTable),
        organizationId: schema.membersTable.organizationId,
      })
      .from(schema.usersTable)
      .innerJoin(
        schema.membersTable,
        eq(schema.usersTable.id, schema.membersTable.userId),
      )
      .where(eq(schema.usersTable.id, id))
      .limit(1);
    logger.debug({ found: !!user }, "UserModel.getById: completed");
    return user;
  }

  /**
   * Find a user by their email address
   */
  static async findByEmail(email: string) {
    logger.debug({ email }, "UserModel.findByEmail: fetching user");
    const [user] = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.email, email))
      .limit(1);
    logger.debug({ email, found: !!user }, "UserModel.findByEmail: completed");
    return user;
  }

  /**
   * Get all permissions for a user
   */
  static async getUserPermissions(
    userId: string,
    organizationId: string,
  ): Promise<Permissions> {
    // logger.debug(
    //   { userId, organizationId },
    //   "UserModel.getUserPermissions: fetching permissions",
    // );
    // Get user's member record to find their role
    const memberRecord = await MemberModel.getByUserId(userId, organizationId);

    if (!memberRecord) {
      logger.debug(
        { userId, organizationId },
        "UserModel.getUserPermissions: no member record found",
      );
      return {};
    }

    const permissions = await OrganizationRoleModel.getPermissions(
      memberRecord.role,
      organizationId,
    );
    // logger.debug(
    //   { userId, organizationId, role: memberRecord.role },
    //   "UserModel.getUserPermissions: completed",
    // );
    return permissions;
  }

  /**
   * Get the default admin user by email
   */
  static async getUserWithByDefaultEmail() {
    logger.debug(
      { email: DEFAULT_ADMIN_EMAIL },
      "UserModel.getUserWithByDefaultEmail: fetching default admin user",
    );
    const [adminUser] = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.email, DEFAULT_ADMIN_EMAIL))
      .limit(1);
    logger.debug(
      { found: !!adminUser },
      "UserModel.getUserWithByDefaultEmail: completed",
    );
    return adminUser;
  }

  /**
   * Update a user with partial data
   */
  static async patch(userId: string, data: Partial<UpdateUser>) {
    logger.debug({ userId, data }, "UserModel.patch: updating user");
    const result = await db
      .update(schema.usersTable)
      .set(data)
      .where(eq(schema.usersTable.id, userId));
    logger.debug({ userId }, "UserModel.patch: completed");
    return result;
  }

  /**
   * Delete a user by ID
   */
  static async delete(userId: string): Promise<boolean> {
    logger.debug("UserModel.delete: deleting user");
    const result = await db
      .delete(schema.usersTable)
      .where(eq(schema.usersTable.id, userId))
      .returning();
    const deleted = result.length > 0;
    logger.debug({ deleted }, "UserModel.delete: completed");
    return deleted;
  }
}

export default UserModel;
