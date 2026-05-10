import {
  ADMIN_ROLE_NAME,
  DEFAULT_ADMIN_EMAIL,
  type Permissions,
  type PredefinedRoleName,
} from "@shared";
import { and, eq, getTableColumns } from "drizzle-orm";
import { betterAuth } from "@/auth";
import config from "@/config";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/_soft-delete";
import { hardDelete, softDelete } from "@/database/soft-delete";
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
        .where(
          and(
            eq(schema.usersTable.email, email),
            notDeleted(schema.usersTable),
          ),
        );
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
          .where(
            and(
              eq(schema.usersTable.email, email),
              notDeleted(schema.usersTable),
            ),
          );

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
   * Get a user by ID with their organization membership.
   */
  static async getById(id: string, opts: { includeDeleted?: boolean } = {}) {
    logger.trace("UserModel.getById: fetching user");
    const conditions = [eq(schema.usersTable.id, id)];
    if (!opts.includeDeleted) {
      conditions.push(notDeleted(schema.usersTable));
    }
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
      .where(and(...conditions))
      .limit(1);
    logger.trace({ found: !!user }, "UserModel.getById: completed");
    return user;
  }

  /**
   * Find a user by their email address.
   */
  static async findByEmail(
    email: string,
    opts: { includeDeleted?: boolean } = {},
  ) {
    logger.debug({ email }, "UserModel.findByEmail: fetching user");
    const conditions = [eq(schema.usersTable.email, email)];
    if (!opts.includeDeleted) {
      conditions.push(notDeleted(schema.usersTable));
    }
    const [user] = await db
      .select()
      .from(schema.usersTable)
      .where(and(...conditions))
      .limit(1);
    logger.debug({ email, found: !!user }, "UserModel.findByEmail: completed");
    return user;
  }

  /**
   * Get all permissions for a user.
   */
  static async getUserPermissions(
    userId: string,
    organizationId: string,
  ): Promise<Permissions> {
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
    return permissions;
  }

  /**
   * Get the default admin user by email.
   */
  static async getUserWithByDefaultEmail() {
    logger.debug(
      { email: DEFAULT_ADMIN_EMAIL },
      "UserModel.getUserWithByDefaultEmail: fetching default admin user",
    );
    const [adminUser] = await db
      .select()
      .from(schema.usersTable)
      .where(
        and(
          eq(schema.usersTable.email, DEFAULT_ADMIN_EMAIL),
          notDeleted(schema.usersTable),
        ),
      )
      .limit(1);
    logger.debug(
      { found: !!adminUser },
      "UserModel.getUserWithByDefaultEmail: completed",
    );
    return adminUser;
  }

  /**
   * Update a user with partial data.
   */
  static async patch(userId: string, data: Partial<UpdateUser>) {
    logger.debug({ userId, data }, "UserModel.patch: updating user");
    const result = await db
      .update(schema.usersTable)
      .set(data)
      .where(
        and(eq(schema.usersTable.id, userId), notDeleted(schema.usersTable)),
      );
    logger.debug({ userId }, "UserModel.patch: completed");
    return result;
  }

  /**
   * Soft-delete a user and tombstone the email so the address is freed for
   * re-registration without weakening the global uniqueness invariant on
   * `user.email`.
   *
   * Auth-side cascade (sessions, accounts, two_factor, oauth tokens, api
   * keys, user tokens) is wired up by the better-auth integration; callers
   * from that layer should pass the surrounding transaction.
   */
  static async delete(userId: string, tx?: Transaction): Promise<boolean> {
    logger.debug("UserModel.delete: soft-deleting user");
    const dbOrTx = tx ?? db;
    await dbOrTx
      .update(schema.usersTable)
      .set({ email: makeEmailTombstone() })
      .where(
        and(eq(schema.usersTable.id, userId), notDeleted(schema.usersTable)),
      );
    const count = await softDelete(
      dbOrTx,
      schema.usersTable,
      eq(schema.usersTable.id, userId),
    );
    logger.debug({ deleted: count > 0 }, "UserModel.delete: completed");
    return count > 0;
  }

  /**
   * Physically remove a user row. Reserved for purge flows and test cleanup
   * — application code should call `delete` instead.
   */
  static async hardDelete(userId: string, tx?: Transaction): Promise<boolean> {
    const count = await hardDelete(
      tx ?? db,
      schema.usersTable,
      eq(schema.usersTable.id, userId),
    );
    return count > 0;
  }
}

export default UserModel;

function makeEmailTombstone(): string {
  return `deleted-${crypto.randomUUID()}@archestra.invalid`;
}
