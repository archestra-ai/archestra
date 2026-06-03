import {
  ADMIN_ROLE_NAME,
  DEFAULT_ADMIN_EMAIL,
  type Permissions,
  type PredefinedRoleName,
} from "@archestra/shared";
import { and, count, eq, getTableColumns, inArray } from "drizzle-orm";
import { betterAuth } from "@/auth";
import config from "@/config";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { hardDelete, softDelete } from "@/database/soft-delete";
import logger from "@/logging";
import type { UpdateUser } from "@/types";
import AccountModel from "./account";
import ApiKeyModel from "./api-key";
import MemberModel from "./member";
import OAuthAccessTokenModel from "./oauth-access-token";
import OAuthConsentModel from "./oauth-consent";
import OAuthRefreshTokenModel from "./oauth-refresh-token";
import OrganizationRoleModel from "./organization-role";
import SessionModel from "./session";
import TwoFactorModel from "./two-factor";
import UserTokenModel from "./user-token";

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
   * Email only, with no membership requirement (unlike getById's join) —
   * used to label per-user storage folders.
   */
  static async getEmailById(id: string): Promise<string | null> {
    const [row] = await db
      .select({ email: schema.usersTable.email })
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, id))
      .limit(1);
    return row?.email ?? null;
  }

  /** Display names for several users in one query, keyed by user id. */
  static async getNamesByIds(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await db
      .select({ id: schema.usersTable.id, name: schema.usersTable.name })
      .from(schema.usersTable)
      .where(inArray(schema.usersTable.id, ids));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /** Display name for a single user, or null if missing/deleted. */
  static async findNameById(id: string): Promise<string | null> {
    const [row] = await db
      .select({ name: schema.usersTable.name })
      .from(schema.usersTable)
      .where(and(eq(schema.usersTable.id, id), notDeleted(schema.usersTable)))
      .limit(1);
    return row?.name ?? null;
  }

  /**
   * Total number of user rows. Used by the enterprise-tier service to apply
   * the small-team free tier (every row counts, banned or not).
   */
  static async countAll(): Promise<number> {
    const [row] = await db.select({ count: count() }).from(schema.usersTable);
    return row?.count ?? 0;
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
   * `user.email`. Auth-side records (sessions, accounts, two_factor, api
   * keys, oauth tokens, oauth consents) are hard-deleted and personal user
   * tokens are soft-deleted so the user cannot re-authenticate and
   * downstream OAuth clients lose access.
   */
  static async delete(userId: string, tx?: Transaction): Promise<boolean> {
    logger.debug("UserModel.delete: soft-deleting user");
    // The cascade spans several tables; run it atomically so a mid-way failure
    // can't leave a half-deleted user (e.g. sessions gone but email not freed).
    // When a caller already supplies a transaction, reuse it.
    const run = (txn: Transaction) => UserModel.runDeleteCascade(userId, txn);
    const count = tx ? await run(tx) : await withDbTransaction(run);
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

  private static async runDeleteCascade(
    userId: string,
    tx: Transaction,
  ): Promise<number> {
    await SessionModel.deleteAllByUserId(userId, tx);
    await AccountModel.deleteAllByUserId(userId, tx);
    await ApiKeyModel.deleteAllByUserId(userId, tx);
    await UserTokenModel.deleteAllByUserId(userId, tx);
    await TwoFactorModel.deleteAllByUserId(userId, tx);
    await OAuthAccessTokenModel.deleteAllByUserId(userId, tx);
    await OAuthRefreshTokenModel.deleteAllByUserId(userId, tx);
    await OAuthConsentModel.deleteAllByUserId(userId, tx);
    await tx
      .update(schema.usersTable)
      .set({ email: makeEmailTombstone() })
      .where(
        and(eq(schema.usersTable.id, userId), notDeleted(schema.usersTable)),
      );
    return softDelete(tx, schema.usersTable, eq(schema.usersTable.id, userId));
  }
}

export default UserModel;

function makeEmailTombstone(): string {
  return `deleted-${crypto.randomUUID()}@archestra.invalid`;
}
