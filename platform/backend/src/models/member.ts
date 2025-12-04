import type { AnyRoleName } from "@shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";

class MemberModel {
  static async create(
    userId: string,
    organizationId: string,
    role: AnyRoleName,
  ) {
    return await db
      .insert(schema.membersTable)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        userId,
        role,
        createdAt: new Date(),
      })
      .returning();
  }

  /**
   * Get a member by user ID and organization ID.
   */
  static async getByUserId(userId: string, organizationId: string) {
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
    return member;
  }

  /**
   * Get the first membership for a user (any organization).
   * Used when setting initial active organization on sign-in.
   */
  static async getFirstMembershipForUser(userId: string) {
    const [member] = await db
      .select()
      .from(schema.membersTable)
      .where(eq(schema.membersTable.userId, userId))
      .limit(1);
    return member;
  }

  static async deleteByMemberOrUserId(
    memberIdOrUserId: string,
    organizationId: string,
  ) {
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

    return deleted[0];
  }
}

export default MemberModel;
