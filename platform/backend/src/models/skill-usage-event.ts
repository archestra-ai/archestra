import { and, count, countDistinct, eq, gte, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { SkillUsageStatistics } from "@/types";
import { describeUsageActors } from "./skill-usage-actors";

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
   * (UTC calendar days, empty days omitted) plus per-actor totals with display
   * names resolved from whichever table owns the id.
   *
   * The log stores a bare id, so resolution is two lookups: real user ids
   * against `users`, and synthetic `service-account:<id>` ids against
   * `service_accounts` (scoped to `organizationId`). Each row carries a `kind`
   * saying what its id addresses, which stays meaningful when the owning row is
   * gone: `name: null` then means deleted, and a caller can still say whether a
   * deleted *user* or a deleted *service account* ran the skill instead of
   * lumping them — and an unattributed activation — into one "unknown" bucket.
   */
  static async getUsageStatistics(params: {
    skillId: string;
    since: Date;
    organizationId: string;
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
    const users = await describeUsageActors({
      totals,
      organizationId: params.organizationId,
    });

    return {
      since: params.since.toISOString(),
      users,
      daily: rows,
    };
  }
}

export default SkillUsageEventModel;
