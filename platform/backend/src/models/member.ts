import type { AnyRoleName } from "@archestra/shared";
import { and, count, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import { createPaginatedResult } from "@/database/utils/pagination";
import logger from "@/logging";

class MemberModel {
  /**
   * Create a new member (user-organization relationship)
   */
  static async create(
    userId: string,
    organizationId: string,
    role: AnyRoleName,
  ) {
    logger.debug(
      { userId, organizationId, role },
      "MemberModel.create: creating member",
    );
    const result = await db
      .insert(schema.membersTable)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        userId,
        role,
        createdAt: new Date(),
      })
      .returning();
    logger.debug(
      { userId, organizationId, memberId: result[0]?.id },
      "MemberModel.create: completed",
    );
    return result;
  }

  /**
   * Get a member by their member ID
   */
  static async getById(memberId: string) {
    logger.debug({ memberId }, "MemberModel.getById: fetching member");
    const [member] = await db
      .select()
      .from(schema.membersTable)
      .where(eq(schema.membersTable.id, memberId))
      .limit(1);
    logger.debug(
      { memberId, found: !!member },
      "MemberModel.getById: completed",
    );
    return member;
  }

  /**
   * Get a member by user ID and organization ID.
   *
   * The member table has no unique constraint on (userId, organizationId).
   * Order by createdAt so a stale duplicate row can't shadow the seeded one:
   * the original membership is always older than any later duplicate created
   * (e.g. by an auto-accepted invitation), so it wins.
   */
  static async getByUserId(
    userId: string,
    organizationId: string,
    tx?: Transaction,
  ) {
    const dbOrTx = tx ?? db;
    const [member] = await dbOrTx
      .select()
      .from(schema.membersTable)
      .where(
        and(
          eq(schema.membersTable.userId, userId),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      )
      .orderBy(schema.membersTable.createdAt, schema.membersTable.id)
      .limit(1);
    return member;
  }

  static async listMembersWithoutAccounts(
    organizationId: string,
    tx?: Transaction,
  ) {
    const dbOrTx = tx ?? db;
    return await dbOrTx
      .select({
        id: schema.usersTable.id,
        email: schema.usersTable.email,
        name: schema.usersTable.name,
        image: schema.usersTable.image,
        role: schema.membersTable.role,
      })
      .from(schema.membersTable)
      .innerJoin(
        schema.usersTable,
        eq(schema.membersTable.userId, schema.usersTable.id),
      )
      .leftJoin(
        schema.accountsTable,
        eq(schema.accountsTable.userId, schema.usersTable.id),
      )
      .where(
        and(
          eq(schema.membersTable.organizationId, organizationId),
          isNull(schema.accountsTable.id),
        ),
      );
  }

  /**
   * Get the first membership for a user (any organization).
   * Used when setting initial active organization on sign-in.
   */
  static async getFirstMembershipForUser(userId: string) {
    logger.debug(
      { userId },
      "MemberModel.getFirstMembershipForUser: fetching first membership",
    );
    const [member] = await db
      .select()
      .from(schema.membersTable)
      .where(eq(schema.membersTable.userId, userId))
      .orderBy(schema.membersTable.createdAt, schema.membersTable.id)
      .limit(1);
    logger.debug(
      { userId, found: !!member, organizationId: member?.organizationId },
      "MemberModel.getFirstMembershipForUser: completed",
    );
    return member;
  }

  /**
   * Count memberships for a user across all organizations
   * Used to check if user should be deleted after member removal
   */
  static async countByUserId(
    userId: string,
    tx?: Transaction,
  ): Promise<number> {
    logger.debug({ userId }, "MemberModel.countByUserId: counting memberships");
    const dbOrTx = tx ?? db;
    const [result] = await dbOrTx
      .select({ count: count() })
      .from(schema.membersTable)
      .where(eq(schema.membersTable.userId, userId));
    const memberCount = result?.count ?? 0;
    logger.debug(
      { userId, count: memberCount },
      "MemberModel.countByUserId: completed",
    );
    return memberCount;
  }

  /**
   * Check if a user has any memberships remaining
   */
  static async hasAnyMembership(
    userId: string,
    tx?: Transaction,
  ): Promise<boolean> {
    logger.debug(
      { userId },
      "MemberModel.hasAnyMembership: checking for memberships",
    );
    const memberCount = await MemberModel.countByUserId(userId, tx);
    const hasMembership = memberCount > 0;
    logger.debug(
      { userId, hasMembership },
      "MemberModel.hasAnyMembership: completed",
    );
    return hasMembership;
  }

  static async deleteAllByUserId(userId: string, tx?: Transaction) {
    logger.debug(
      { userId },
      "MemberModel.deleteAllByUserId: deleting memberships",
    );
    const dbOrTx = tx ?? db;
    const deleted = await dbOrTx
      .delete(schema.membersTable)
      .where(eq(schema.membersTable.userId, userId))
      .returning({ id: schema.membersTable.id });
    logger.debug(
      { userId, count: deleted.length },
      "MemberModel.deleteAllByUserId: completed",
    );
    return deleted.length;
  }

  /**
   * Update a member's role
   */
  static async updateRole(
    userId: string,
    organizationId: string,
    newRole: AnyRoleName,
  ) {
    logger.debug(
      { userId, organizationId, newRole },
      "MemberModel.updateRole: updating member role",
    );
    const result = await db
      .update(schema.membersTable)
      .set({ role: newRole })
      .where(
        and(
          eq(schema.membersTable.userId, userId),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      )
      .returning();
    logger.debug(
      { userId, organizationId, updated: !!result[0], newRole },
      "MemberModel.updateRole: completed",
    );
    return result[0];
  }

  /**
   * Get all members of an organization with user details
   */
  static async findAllByOrganization(organizationId: string) {
    logger.debug(
      { organizationId },
      "MemberModel.findAllByOrganization: fetching members",
    );
    const results = await db
      .select({
        id: schema.usersTable.id,
        name: schema.usersTable.name,
        email: schema.usersTable.email,
        role: schema.membersTable.role,
        systemRole: schema.usersTable.role,
      })
      .from(schema.membersTable)
      .innerJoin(
        schema.usersTable,
        eq(schema.membersTable.userId, schema.usersTable.id),
      )
      .where(eq(schema.membersTable.organizationId, organizationId))
      .orderBy(schema.usersTable.name);
    logger.debug(
      { organizationId, count: results.length },
      "MemberModel.findAllByOrganization: completed",
    );
    return results;
  }

  static async findUserIdsInOrganization(params: {
    organizationId: string;
    userIds: string[];
  }): Promise<string[]> {
    if (params.userIds.length === 0) {
      return [];
    }

    const rows = await db
      .select({ userId: schema.membersTable.userId })
      .from(schema.membersTable)
      .where(
        and(
          eq(schema.membersTable.organizationId, params.organizationId),
          inArray(schema.membersTable.userId, params.userIds),
        ),
      );

    return rows.map((row) => row.userId);
  }

  /**
   * Get paginated members of an organization with optional filters
   */
  static async findAllPaginated(params: {
    organizationId: string;
    pagination: { limit: number; offset: number };
    name?: string;
    role?: string;
  }) {
    const { organizationId, pagination, name, role } = params;
    const searchPattern = name ? `%${name}%` : null;

    const filters = [
      eq(schema.membersTable.organizationId, organizationId),
      ...(role ? [eq(schema.membersTable.role, role)] : []),
      ...(searchPattern
        ? [
            or(
              ilike(schema.usersTable.name, searchPattern),
              ilike(schema.usersTable.email, searchPattern),
            ),
          ]
        : []),
    ];

    const [data, totalResult] = await Promise.all([
      db
        .select({
          id: schema.membersTable.id,
          userId: schema.membersTable.userId,
          role: schema.membersTable.role,
          createdAt: schema.membersTable.createdAt,
          name: schema.usersTable.name,
          email: schema.usersTable.email,
          image: schema.usersTable.image,
        })
        .from(schema.membersTable)
        .innerJoin(
          schema.usersTable,
          eq(schema.membersTable.userId, schema.usersTable.id),
        )
        .where(and(...filters))
        .orderBy(schema.usersTable.name)
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ count: count() })
        .from(schema.membersTable)
        .innerJoin(
          schema.usersTable,
          eq(schema.membersTable.userId, schema.usersTable.id),
        )
        .where(and(...filters)),
    ]);

    const total = totalResult[0]?.count ?? 0;
    return createPaginatedResult(data, total, pagination);
  }

  /**
   * Find a member by user ID or email within an organization
   */
  static async findByIdOrEmail(idOrEmail: string, organizationId: string) {
    logger.debug(
      { idOrEmail, organizationId },
      "MemberModel.findByIdOrEmail: fetching member",
    );
    const [result] = await db
      .select({
        id: schema.usersTable.id,
        name: schema.usersTable.name,
        email: schema.usersTable.email,
        role: schema.membersTable.role,
      })
      .from(schema.membersTable)
      .innerJoin(
        schema.usersTable,
        eq(schema.membersTable.userId, schema.usersTable.id),
      )
      .where(
        and(
          eq(schema.membersTable.organizationId, organizationId),
          or(
            eq(schema.usersTable.id, idOrEmail),
            eq(schema.usersTable.email, idOrEmail),
          ),
        ),
      )
      .limit(1);
    logger.debug(
      { idOrEmail, organizationId, found: !!result },
      "MemberModel.findByIdOrEmail: completed",
    );
    return result;
  }

  /**
   * Delete a member by member ID or user ID + organization ID
   */
  static async deleteByMemberOrUserId(
    memberIdOrUserId: string,
    organizationId: string,
    tx?: Transaction,
  ) {
    logger.debug(
      { memberIdOrUserId, organizationId },
      "MemberModel.deleteByMemberOrUserId: deleting member",
    );
    const dbOrTx = tx ?? db;
    // Try to delete by member ID first
    let deleted = await dbOrTx
      .delete(schema.membersTable)
      .where(eq(schema.membersTable.id, memberIdOrUserId))
      .returning();

    // If not found, try by user ID + organization ID
    if (!deleted[0] && organizationId) {
      deleted = await dbOrTx
        .delete(schema.membersTable)
        .where(
          and(
            eq(schema.membersTable.userId, memberIdOrUserId),
            eq(schema.membersTable.organizationId, organizationId),
          ),
        )
        .returning();
    }

    logger.debug(
      { memberIdOrUserId, organizationId, deleted: !!deleted[0] },
      "MemberModel.deleteByMemberOrUserId: completed",
    );
    return deleted[0];
  }
  /**
   * Set the default agent for a member
   */
  static async setDefaultAgent(
    userId: string,
    organizationId: string,
    agentId: string | null,
  ) {
    await db
      .update(schema.membersTable)
      .set({ defaultAgentId: agentId })
      .where(
        and(
          eq(schema.membersTable.userId, userId),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      );
  }

  /**
   * Set the member's default model and API key. The two are a pair — callers
   * must pass both or neither (see `isModelSelectionComplete`).
   */
  static async setDefaultModelSelection(params: {
    userId: string;
    organizationId: string;
    modelId: string | null;
    apiKeyId: string | null;
  }) {
    const { userId, organizationId, modelId, apiKeyId } = params;
    await db
      .update(schema.membersTable)
      .set({ defaultModelId: modelId, defaultChatApiKeyId: apiKeyId })
      .where(
        and(
          eq(schema.membersTable.userId, userId),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      );
  }

  /**
   * Get the member's default (model, key) pair. Either both ids are set or
   * both are null (see `isModelSelectionComplete`).
   */
  static async getDefaultModelSelection(
    userId: string,
    organizationId: string,
  ): Promise<{ modelId: string | null; chatApiKeyId: string | null }> {
    const [member] = await db
      .select({
        defaultModelId: schema.membersTable.defaultModelId,
        defaultChatApiKeyId: schema.membersTable.defaultChatApiKeyId,
      })
      .from(schema.membersTable)
      .where(
        and(
          eq(schema.membersTable.userId, userId),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    return {
      modelId: member?.defaultModelId ?? null,
      chatApiKeyId: member?.defaultChatApiKeyId ?? null,
    };
  }

  /**
   * Get the default agent ID for a member
   */
  static async getDefaultAgentId(
    userId: string,
    organizationId: string,
  ): Promise<string | null> {
    const [member] = await db
      .select({ defaultAgentId: schema.membersTable.defaultAgentId })
      .from(schema.membersTable)
      .where(
        and(
          eq(schema.membersTable.userId, userId),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    return member?.defaultAgentId ?? null;
  }

  /**
   * Check if any member references the given agent as their default
   */
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select()
      .from(schema.membersTable)
      .where(
        and(
          eq(schema.membersTable.id, id),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!row) return null;

    return {
      id: row.id,
      organizationId: row.organizationId,
      userId: row.userId,
      role: row.role,
      createdAt: row.createdAt.toISOString(),
    };
  }

  static async findByUserIdForAudit(
    userId: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select()
      .from(schema.membersTable)
      .where(
        and(
          eq(schema.membersTable.userId, userId),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!row) return null;

    return {
      id: row.id,
      organizationId: row.organizationId,
      userId: row.userId,
      role: row.role,
      defaultAgentId: row.defaultAgentId ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  static async isAgentDefault(agentId: string): Promise<boolean> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.membersTable)
      .where(eq(schema.membersTable.defaultAgentId, agentId));
    return (result?.count ?? 0) > 0;
  }
}

export default MemberModel;
