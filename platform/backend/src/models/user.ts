import {
  ADMIN_ROLE_NAME,
  DEFAULT_ADMIN_EMAIL,
  type Permissions,
  type PredefinedRoleName,
} from "@archestra/shared";
import { count, eq, getTableColumns, inArray } from "drizzle-orm";
import config from "@/config";
import db, { schema, type Transaction } from "@/database";
import logger from "@/logging";
import type { UpdateUser } from "@/types";
import AgentModel from "./agent";
import McpServerModel from "./mcp-server";
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

      // Imported lazily so that merely importing UserModel does not construct
      // the Better Auth instance (which eagerly initializes its context and
      // requires the auth secret). This keeps UserModel usable from standalone
      // scripts that never sign anyone up.
      const { betterAuth } = await import("@/auth");
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
   * Get a user by ID with their organization membership.
   *
   * This is what resolves `request.organizationId` for both session and
   * API-key auth (auth/fastify-plugin/middleware.ts), so the membership picked
   * here decides which org a request is scoped to.
   *
   * The ordering is load-bearing for users who belong to more than one org:
   * `limit(1)` on an unordered join lets Postgres return a different membership
   * across queries or plans, which would make org-scoped results flicker. It
   * matches `MemberModel.getFirstMembershipForUser` exactly so the org resolved
   * here agrees with the `activeOrganizationId` better-auth stamps on the
   * session (auth/better-auth.ts session-create hook).
   */
  static async getById(id: string) {
    logger.trace("UserModel.getById: fetching user");
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
      .orderBy(schema.membersTable.createdAt, schema.membersTable.id)
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

  /**
   * Total number of user rows. Used by the enterprise-tier service to apply
   * the small-team free tier (every row counts, banned or not).
   */
  static async countAll(): Promise<number> {
    const [row] = await db.select({ count: count() }).from(schema.usersTable);
    return row?.count ?? 0;
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
  static async patch(
    userId: string,
    data: Partial<UpdateUser>,
    tx?: Transaction,
  ) {
    logger.debug({ userId, data }, "UserModel.patch: updating user");
    const dbOrTx = tx ?? db;
    const result = await dbOrTx
      .update(schema.usersTable)
      .set(data)
      .where(eq(schema.usersTable.id, userId));
    logger.debug({ userId }, "UserModel.patch: completed");
    return result;
  }

  /**
   * Delete a user by ID, along with the personal resources that must not
   * outlive them.
   *
   * The cleanup lives HERE and not in better-auth's `user.delete.before`
   * database hook: every real deletion path (member removal, pending-member
   * delete, linked-IdP auth, rejected-SSO cleanup) calls this method, and a
   * raw Drizzle delete does not run better-auth hooks. Cleanup placed in that
   * hook looks correct and never fires.
   *
   * Runs before the delete because it resolves rows through `owner_id`, which
   * the `set null` FK would clear.
   */
  static async delete(userId: string, tx?: Transaction): Promise<boolean> {
    logger.debug("UserModel.delete: deleting user");

    // Personal MCP installs hold the user's own credentials (OAuth tokens,
    // prompted secrets). `mcp_server.owner_id` is `set null`, so without this
    // the install survives ownerless with its secret bag intact.
    try {
      await McpServerModel.purgePersonalServersForUser(userId);
    } catch (error) {
      // Don't block the deletion on cleanup failure — a user who asked to be
      // removed must still be removed. Individual install failures are already
      // swallowed one level down; this catches a total failure of the query.
      logger.error(
        { err: error, userId },
        "UserModel.delete: failed to purge personal MCP servers",
      );
    }

    // Personal gateways/proxies are agents the deletion guard in
    // routes/agent.ts refuses to delete while `is_personal_gateway` is true,
    // so an orphan here is undeletable. better-auth's hook also does this, for
    // the paths that go through better-auth; both are idempotent.
    try {
      await AgentModel.deletePersonalMcpGatewaysForUser(userId);
    } catch (error) {
      logger.error(
        { err: error, userId },
        "UserModel.delete: failed to delete personal MCP gateways",
      );
    }
    try {
      await AgentModel.deletePersonalLlmProxiesForUser(userId);
    } catch (error) {
      logger.error(
        { err: error, userId },
        "UserModel.delete: failed to delete personal LLM proxies",
      );
    }

    const dbOrTx = tx ?? db;
    const result = await dbOrTx
      .delete(schema.usersTable)
      .where(eq(schema.usersTable.id, userId))
      .returning();
    const deleted = result.length > 0;
    logger.debug({ deleted }, "UserModel.delete: completed");
    return deleted;
  }
}

export default UserModel;
