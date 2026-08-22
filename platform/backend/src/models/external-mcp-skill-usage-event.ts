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
import UserModel from "./user";

type UsageRef = { mcpServerId: string; uri: string };
type UsageSummary = {
  usageCount: number;
  usageUserCount: number;
  lastUsedAt: Date | null;
};

class ExternalMcpSkillUsageEventModel {
  /** Record one successful name-only external Skill activation. */
  static recordUsage(
    params: UsageRef & {
      userId: string | null;
      sessionId?: string | null;
      contextTokens?: number | null;
    },
  ): void {
    const usedAt = new Date();
    const write = db.insert(schema.externalMcpSkillUsageEventsTable).values({
      mcpServerId: params.mcpServerId,
      uri: params.uri,
      userId: params.userId,
      sessionId: params.sessionId ?? null,
      contextTokens: params.contextTokens ?? null,
      createdAt: usedAt,
    });

    trackBackgroundWork(
      Promise.resolve(write).catch((error) => {
        logger.warn(
          {
            error,
            mcpServerId: params.mcpServerId,
            skillUri: params.uri,
          },
          "[Skills] Failed to record external MCP Skill usage",
        );
      }),
    );
  }

  /** Batch aggregate usage for installation-qualified Skill references. */
  static async getSummaries(
    refs: UsageRef[],
  ): Promise<Map<string, Map<string, UsageSummary>>> {
    if (refs.length === 0) return new Map();

    const serverIds = [...new Set(refs.map((ref) => ref.mcpServerId))];
    const uris = [...new Set(refs.map((ref) => ref.uri))];
    const rows = await db
      .select({
        mcpServerId: schema.externalMcpSkillUsageEventsTable.mcpServerId,
        uri: schema.externalMcpSkillUsageEventsTable.uri,
        usageCount: count(),
        usageUserCount: countDistinct(
          schema.externalMcpSkillUsageEventsTable.userId,
        ),
        lastUsedAt: max(schema.externalMcpSkillUsageEventsTable.createdAt),
      })
      .from(schema.externalMcpSkillUsageEventsTable)
      .where(
        and(
          inArray(
            schema.externalMcpSkillUsageEventsTable.mcpServerId,
            serverIds,
          ),
          inArray(schema.externalMcpSkillUsageEventsTable.uri, uris),
        ),
      )
      .groupBy(
        schema.externalMcpSkillUsageEventsTable.mcpServerId,
        schema.externalMcpSkillUsageEventsTable.uri,
      );

    const summaries = new Map<string, Map<string, UsageSummary>>();
    for (const row of rows) {
      const byUri = summaries.get(row.mcpServerId) ?? new Map();
      byUri.set(row.uri, {
        usageCount: row.usageCount,
        usageUserCount: row.usageUserCount,
        lastUsedAt: row.lastUsedAt,
      });
      summaries.set(row.mcpServerId, byUri);
    }
    return summaries;
  }

  /** Per-user daily activations for one installation-qualified Skill. */
  static async getUsageStatistics(
    params: UsageRef & { since: Date },
  ): Promise<SkillUsageStatistics> {
    const day = sql<string>`to_char(date_trunc('day', ${schema.externalMcpSkillUsageEventsTable.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
    const rows = await db
      .select({
        date: day,
        userId: schema.externalMcpSkillUsageEventsTable.userId,
        count: count(),
      })
      .from(schema.externalMcpSkillUsageEventsTable)
      .where(
        and(
          eq(
            schema.externalMcpSkillUsageEventsTable.mcpServerId,
            params.mcpServerId,
          ),
          eq(schema.externalMcpSkillUsageEventsTable.uri, params.uri),
          gte(schema.externalMcpSkillUsageEventsTable.createdAt, params.since),
        ),
      )
      .groupBy(day, schema.externalMcpSkillUsageEventsTable.userId)
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

export default ExternalMcpSkillUsageEventModel;
