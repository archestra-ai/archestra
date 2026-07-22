import { and, count, countDistinct, eq, gte, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { SkillUsageStatistics } from "@/types";
import UserModel from "./user";

class SkillUsageEventModel {
  /**
   * Distinct attributed users per skill, across the whole event log. Events
   * with no user (`userId: null`) are not counted, so a skill whose recorded
   * activations are all unattributed reports 0.
   */
  static async countDistinctUsersBySkillIds(
    skillIds: string[],
  ): Promise<Map<string, number>> {
    if (skillIds.length === 0) return new Map();
    const rows = await db
      .select({
        skillId: schema.skillUsageEventsTable.skillId,
        count: countDistinct(schema.skillUsageEventsTable.userId),
      })
      .from(schema.skillUsageEventsTable)
      .where(inArray(schema.skillUsageEventsTable.skillId, skillIds))
      .groupBy(schema.skillUsageEventsTable.skillId);
    return new Map(rows.map((row) => [row.skillId, row.count]));
  }

  /**
   * Per-user activation analytics for one skill since `since`: daily counts
   * (UTC calendar days, empty days omitted) plus per-user totals with display
   * names resolved from the `users` table. Ids without a `users` row (deleted
   * users, synthetic service-account ids) keep `name: null`.
   */
  static async getUsageStatistics(params: {
    skillId: string;
    since: Date;
  }): Promise<SkillUsageStatistics> {
    const day = sql<string>`to_char(date_trunc('day', ${schema.skillUsageEventsTable.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
    const rows = await db
      .select({
        date: day,
        userId: schema.skillUsageEventsTable.userId,
        count: count(),
      })
      .from(schema.skillUsageEventsTable)
      .where(
        and(
          eq(schema.skillUsageEventsTable.skillId, params.skillId),
          gte(schema.skillUsageEventsTable.createdAt, params.since),
        ),
      )
      .groupBy(day, schema.skillUsageEventsTable.userId)
      .orderBy(day);

    const totals = new Map<string | null, number>();
    for (const row of rows) {
      totals.set(row.userId, (totals.get(row.userId) ?? 0) + row.count);
    }
    const userIds = [...totals.keys()].filter(
      (id): id is string => id !== null,
    );
    const names = await UserModel.getNamesByIds(userIds);

    const users = [...totals.entries()]
      .map(([userId, total]) => ({
        userId,
        name: userId === null ? null : (names.get(userId) ?? null),
        total,
      }))
      .sort((a, b) => b.total - a.total);

    return {
      since: params.since.toISOString(),
      users,
      daily: rows,
    };
  }
}

export default SkillUsageEventModel;
