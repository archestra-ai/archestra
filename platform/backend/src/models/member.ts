import type { AnyRoleName } from "@shared";
import { and, count, eq, ilike, or } from "drizzle-orm";
import db, { schema } from "@/database";
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
   */
  static async getByUserId(userId: string, organizationId: string) {
    // logger.debug(
    //   { userId, organizationId },
    //   "MemberModel.getByUserId: fetching member",
    // );
    const [member] = await db
      .select()
      .from(schema.membersTable)
      .where(
        and(
          eq(schema.membersTable.userId, userId),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    // logger.debug(
    //   { userId, organizationId, found: !!member },
    //   "MemberModel.getByUserId: completed",
    // );
    return member;
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
  static async countByUserId(userId: string): Promise<number> {
    logger.debug({ userId }, "MemberModel.countByUserId: counting memberships");
    const [result] = await db
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
  static async hasAnyMembership(userId: string): Promise<boolean> {
    logger.debug(
      { userId },
      "MemberModel.hasAnyMembership: checking for memberships",
    );
    const memberCount = await MemberModel.countByUserId(userId);
    const hasMembership = memberCount > 0;
    logger.debug(
      { userId, hasMembership },
      "MemberModel.hasAnyMembership: completed",
    );
    return hasMembership;
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
  ) {
    logger.debug(
      { memberIdOrUserId, organizationId },
      "MemberModel.deleteByMemberOrUserId: deleting member",
    );
    // Try to delete by member ID first
    let deleted = await db
      .delete(schema.membersTable)
      .where(eq(schema.membersTable.id, memberIdOrUserId))
      .returning();

    // If not found, try by user ID + organization ID
    if (!deleted[0] && organizationId) {
      deleted = await db
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
  static async isAgentDefault(agentId: string): Promise<boolean> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.membersTable)
      .where(eq(schema.membersTable.defaultAgentId, agentId));
    return (result?.count ?? 0) > 0;
  }
}

export default MemberModel;
