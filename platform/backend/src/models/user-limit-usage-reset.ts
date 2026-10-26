import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";

/**
 * When an admin last reset each user's limit usage. Default user limits only
 * count spend after the marker (see `getDefaultUserLimitUsage` in
 * `models/limit.ts`); custom limits are zeroed directly and keep the marker as
 * a record of when it happened.
 */
class UserLimitUsageResetModel {
  /** Last reset of each given user (all users when omitted), keyed by user id. */
  static async findResets(params: {
    organizationId: string;
    userIds?: string[];
  }): Promise<Map<string, { resetAt: Date; resetByName: string | null }>> {
    if (params.userIds?.length === 0) return new Map();
    const rows = await db
      .select({
        userId: schema.userLimitUsageResetsTable.userId,
        resetAt: schema.userLimitUsageResetsTable.resetAt,
        resetByName: schema.usersTable.name,
      })
      .from(schema.userLimitUsageResetsTable)
      .leftJoin(
        schema.usersTable,
        eq(
          schema.userLimitUsageResetsTable.resetByUserId,
          schema.usersTable.id,
        ),
      )
      .where(
        and(
          eq(
            schema.userLimitUsageResetsTable.organizationId,
            params.organizationId,
          ),
          params.userIds
            ? inArray(schema.userLimitUsageResetsTable.userId, params.userIds)
            : undefined,
        ),
      );
    return new Map(
      rows.map((row) => [
        row.userId,
        { resetAt: row.resetAt, resetByName: row.resetByName },
      ]),
    );
  }

  /** Record a reset now, replacing the user's previous marker. */
  static async recordReset(params: {
    organizationId: string;
    userId: string;
    resetByUserId: string;
    resetAt?: Date;
  }): Promise<Date> {
    const resetAt = params.resetAt ?? new Date();
    await db
      .insert(schema.userLimitUsageResetsTable)
      .values({
        organizationId: params.organizationId,
        userId: params.userId,
        resetAt,
        resetByUserId: params.resetByUserId,
      })
      .onConflictDoUpdate({
        target: [
          schema.userLimitUsageResetsTable.organizationId,
          schema.userLimitUsageResetsTable.userId,
        ],
        set: { resetAt, resetByUserId: params.resetByUserId },
      });
    return resetAt;
  }

  // Org-scoped snapshot for the audit hook (see middleware/audit-decisions.ts).
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select(auditSelection)
      .from(schema.userLimitUsageResetsTable)
      .where(
        and(
          eq(schema.userLimitUsageResetsTable.id, id),
          eq(schema.userLimitUsageResetsTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Audit snapshot keyed by the reset user. A user who was never reset yields
   * `resetAt: null`, so the first reset still records a before/after diff.
   */
  static async findByUserIdForAudit(
    userId: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [member] = await db
      .select({ userId: schema.membersTable.userId })
      .from(schema.membersTable)
      .where(
        and(
          eq(schema.membersTable.userId, userId),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!member) return null;
    const [row] = await db
      .select(auditSelection)
      .from(schema.userLimitUsageResetsTable)
      .where(
        and(
          eq(schema.userLimitUsageResetsTable.userId, userId),
          eq(schema.userLimitUsageResetsTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? { userId, resetAt: null, resetByUserId: null };
  }
}

const auditSelection = {
  userId: schema.userLimitUsageResetsTable.userId,
  resetAt: schema.userLimitUsageResetsTable.resetAt,
  resetByUserId: schema.userLimitUsageResetsTable.resetByUserId,
};

export default UserLimitUsageResetModel;
