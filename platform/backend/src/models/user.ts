import {
  ADMIN_ROLE_NAME,
  DEFAULT_ADMIN_EMAIL,
  type Permissions,
} from "@shared";
import { and, eq, getTableColumns } from "drizzle-orm";
import { betterAuth } from "@/auth";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { UpdateUser } from "@/types";
import MemberModel from "./member";
import OrganizationModel from "./organization";
import OrganizationRoleModel from "./organization-role";

class UserModel {
  /** Creates user and associates it with an admin member */
  static async createOrGetExistingDefaultAdminUser({
    email = config.auth.adminDefaultEmail,
    password = config.auth.adminDefaultPassword,
    name = "Admin",
    role = ADMIN_ROLE_NAME,
  }: {
    email?: string;
    password?: string;
    name?: string;
    role?: string;
  } = {}) {
    try {
      // Check if user already exists
      const existing = await db
        .select()
        .from(schema.usersTable)
        .where(eq(schema.usersTable.email, email));

      let user = existing[0];

      // Create user if doesn't exist
      if (!user) {
        const result = await betterAuth.api.signUpEmail({
          body: {
            email,
            password,
            name,
          },
        });

        if (!result) {
          throw new Error("Failed to sign up user");
        }

        await db
          .update(schema.usersTable)
          .set({
            emailVerified: true,
          })
          .where(eq(schema.usersTable.email, email));

        // Re-fetch the complete user record from database
        const [createdUser] = await db
          .select()
          .from(schema.usersTable)
          .where(eq(schema.usersTable.email, email));

        user = createdUser;
        logger.info({ email }, "User created successfully");
      } else {
        logger.info({ email }, "User already exists");
      }

      // Ensure default organization exists
      const org = await OrganizationModel.getOrCreateDefaultOrganization();
      if (!org) {
        throw new Error("Failed to get or create default organization");
      }

      // Check if member relationship exists
      const existingMember = await MemberModel.getByUserId(user.id);

      // Create member relationship with specified role if doesn't exist
      if (!existingMember) {
        await MemberModel.create(user.id, org.id, role);
        logger.info({ email, role }, "Member created with role");
      }

      return user;
    } catch (err) {
      logger.error({ err }, "Failed to create default admin user");
    }
  }

  static async getById(id: string) {
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
    return user;
  }

  /**
   * Get all permissions for a user
   */
  static async getUserPermissions(
    userId: string,
    organizationId: string,
  ): Promise<Permissions> {
    // Get user's member record to find their role
    const memberRecord = await db
      .select()
      .from(schema.membersTable)
      .where(
        and(
          eq(schema.membersTable.userId, userId),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!memberRecord[0] || !memberRecord[0].role) {
      return {};
    }

    return OrganizationRoleModel.getPermissions(
      memberRecord[0].role,
      organizationId,
    );
  }

  static async getUserWithByDefaultEmail() {
    const [adminUser] = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.email, DEFAULT_ADMIN_EMAIL))
      .limit(1);
    return adminUser;
  }

  static async patch(userId: string, data: Partial<UpdateUser>) {
    return await db
      .update(schema.usersTable)
      .set(data)
      .where(eq(schema.usersTable.id, userId));
  }
}

export default UserModel;
