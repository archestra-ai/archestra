import type { AnyRoleName } from "@shared";
import { and, count, eq } from "drizzle-orm";
import db, { schema } from "@/database";
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
}

export default MemberModel;
