import {
  and,
  count,
  countDistinct,
  eq,
  gte,
  inArray,
  max,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { SkillUsageStatistics } from "@/types";
import { trackBackgroundWork } from "@/utils/background-work";
import { describeUsageActors } from "./skill-usage-actors";

type UsageRef = { pluginId: string; skillPath: string };
type UsageSummary = {
  usageCount: number;
  usageUserCount: number;
  lastUsedAt: Date | null;
};

class PluginSkillUsageEventModel {
  static recordUsage(
    params: UsageRef & {
      userId: string | null;
      sessionId?: string | null;
      contextTokens?: number | null;
    },
  ): void {
    const write = db.insert(schema.pluginSkillUsageEventsTable).values({
      pluginId: params.pluginId,
      skillPath: params.skillPath,
      userId: params.userId,
      sessionId: params.sessionId ?? null,
      contextTokens: params.contextTokens ?? null,
    });
    trackBackgroundWork(
      Promise.resolve(write).catch((error) => {
        logger.warn(
          { error, pluginId: params.pluginId, skillPath: params.skillPath },
          "[Skills] Failed to record plugin Skill usage",
        );
      }),
    );
  }

  static async getSummaries(
    refs: UsageRef[],
  ): Promise<Map<string, Map<string, UsageSummary>>> {
    if (refs.length === 0) return new Map();
    const rows = await db
      .select({
        pluginId: schema.pluginSkillUsageEventsTable.pluginId,
        skillPath: schema.pluginSkillUsageEventsTable.skillPath,
        usageCount: count(),
        usageUserCount: countDistinct(
          schema.pluginSkillUsageEventsTable.userId,
        ),
        lastUsedAt: max(schema.pluginSkillUsageEventsTable.createdAt),
      })
      .from(schema.pluginSkillUsageEventsTable)
      .where(
        and(
          inArray(schema.pluginSkillUsageEventsTable.pluginId, [
            ...new Set(refs.map((ref) => ref.pluginId)),
          ]),
          inArray(schema.pluginSkillUsageEventsTable.skillPath, [
            ...new Set(refs.map((ref) => ref.skillPath)),
          ]),
        ),
      )
      .groupBy(
        schema.pluginSkillUsageEventsTable.pluginId,
        schema.pluginSkillUsageEventsTable.skillPath,
      );
    const summaries = new Map<string, Map<string, UsageSummary>>();
    for (const row of rows) {
      const byPath = summaries.get(row.pluginId) ?? new Map();
      byPath.set(row.skillPath, {
        usageCount: row.usageCount,
        usageUserCount: row.usageUserCount,
        lastUsedAt: row.lastUsedAt,
      });
      summaries.set(row.pluginId, byPath);
    }
    return summaries;
  }

  static async getUsageStatistics(
    params: UsageRef & { since: Date; organizationId: string },
  ): Promise<SkillUsageStatistics> {
    const day = sql<string>`to_char(date_trunc('day', ${schema.pluginSkillUsageEventsTable.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
    const rows = await db
      .select({
        date: day,
        userId: schema.pluginSkillUsageEventsTable.userId,
        count: count(),
      })
      .from(schema.pluginSkillUsageEventsTable)
      .where(
        and(
          eq(schema.pluginSkillUsageEventsTable.pluginId, params.pluginId),
          eq(schema.pluginSkillUsageEventsTable.skillPath, params.skillPath),
          gte(schema.pluginSkillUsageEventsTable.createdAt, params.since),
        ),
      )
      .groupBy(day, schema.pluginSkillUsageEventsTable.userId)
      .orderBy(day);
    const totals = new Map<string | null, number>();
    for (const row of rows) {
      totals.set(row.userId, (totals.get(row.userId) ?? 0) + row.count);
    }
    return {
      since: params.since.toISOString(),
      users: await describeUsageActors({
        totals,
        organizationId: params.organizationId,
      }),
      daily: rows,
    };
  }
}

export default PluginSkillUsageEventModel;
