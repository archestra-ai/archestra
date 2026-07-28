import type { PaginationQuery, StatisticsTimeFrame } from "@archestra/shared";
import {
  type AnyColumn,
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  type SQL,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type {
  AgentStatistics,
  CostSavingsStatistics,
  ModelStatistics,
  OverviewStatistics,
  SortDirection,
  StatisticsTimeSeriesData,
  StatisticsTimeSeriesPoint,
  StatisticsUserTimeSeriesData,
  TeamStatistics,
  UserModelUsage,
  UserStatistics,
  UserStatisticsSortBy,
} from "@/types";
import AgentTeamModel from "./agent-team";

class StatisticsModel {
  /**
   * Parse custom timeframe to get start and end dates
   */
  private static parseCustomTimeframe(
    timeframe: string,
  ): { startTime: Date; endTime: Date } | null {
    if (!timeframe.startsWith("custom:")) {
      return null;
    }

    const timeframeValue = timeframe.replace("custom:", "");
    const [startTimeStr, endTimeStr] = timeframeValue.split("_");

    if (!startTimeStr || !endTimeStr) {
      return null;
    }

    const startTime = new Date(startTimeStr);
    const endTime = new Date(endTimeStr);

    if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
      return null;
    }

    return { startTime, endTime };
  }

  /**
   * Convert timeframe to SQL interval or return null for custom timeframes
   */
  private static getTimeframeInterval(
    timeframe: StatisticsTimeFrame,
  ): string | null {
    if (typeof timeframe === "string" && timeframe.startsWith("custom:")) {
      return null; // Custom timeframes use date range filtering instead
    }

    switch (timeframe) {
      case "5m":
        return "5 minutes";
      case "15m":
        return "15 minutes";
      case "30m":
        return "30 minutes";
      case "1h":
        return "1 hour";
      case "24h":
        return "24 hours";
      case "7d":
        return "7 days";
      case "30d":
        return "30 days";
      case "90d":
        return "90 days";
      case "12m":
        return "12 months";
      case "all":
        return "100 years"; // Effectively all time
      default:
        return "24 hours";
    }
  }

  /**
   * Get time bucket size for aggregation
   */
  private static getTimeBucket(timeframe: StatisticsTimeFrame): string {
    if (typeof timeframe === "string" && timeframe.startsWith("custom:")) {
      const customRange = StatisticsModel.parseCustomTimeframe(timeframe);
      if (!customRange) return "hour";

      const durationMs =
        customRange.endTime.getTime() - customRange.startTime.getTime();
      const durationHours = durationMs / (1000 * 60 * 60);

      if (durationHours <= 2) return "minute";
      if (durationHours <= 48) return "hour";
      if (durationHours <= 720) return "day"; // 30 days
      return "week";
    }

    switch (timeframe) {
      case "5m":
        return "minute"; // Will show individual minutes for 5-minute range
      case "15m":
        return "minute"; // Will show individual minutes for 15-minute range
      case "30m":
        return "minute"; // We'll round to 5-minute intervals in post-processing
      case "1h":
        return "minute"; // We'll round to 5-minute intervals in post-processing
      case "24h":
        return "hour";
      case "7d":
        return "hour"; // We'll group by 6-hour intervals in post-processing
      case "30d":
        return "day";
      case "90d":
        return "day"; // We'll group by 3-day intervals in post-processing
      case "12m":
        return "week";
      case "all":
        return "month";
      default:
        return "hour";
    }
  }

  /**
   * Get time bucket interval in minutes for custom grouping
   */
  private static getBucketIntervalMinutes(
    timeframe: StatisticsTimeFrame,
  ): number {
    if (typeof timeframe === "string" && timeframe.startsWith("custom:")) {
      const customRange = StatisticsModel.parseCustomTimeframe(timeframe);
      if (!customRange) return 60;

      const durationMs =
        customRange.endTime.getTime() - customRange.startTime.getTime();
      const durationHours = durationMs / (1000 * 60 * 60);

      if (durationHours <= 2) return 5; // 5-minute buckets for short periods
      if (durationHours <= 48) return 60; // 1-hour buckets for up to 2 days
      if (durationHours <= 720) return 1440; // 1-day buckets for up to 30 days
      return 10080; // 1-week buckets for longer periods
    }

    switch (timeframe) {
      case "5m":
        return 1; // 1-minute buckets for 5-minute range
      case "15m":
        return 1; // 1-minute buckets for 15-minute range
      case "30m":
        return 5; // 5-minute buckets for 30-minute range
      case "1h":
        return 5; // 5-minute buckets
      case "24h":
        return 60; // 1-hour buckets
      case "7d":
        return 360; // 6-hour buckets
      case "30d":
        return 1440; // 1-day buckets
      case "90d":
        return 4320; // 3-day buckets
      case "12m":
        return 10080; // 1-week buckets
      case "all":
        return 43200; // 1-month buckets (30 days)
      default:
        return 60; // 1-hour buckets
    }
  }

  /**
   * Round a timestamp down to the start of its bucket.
   *
   * Buckets are aligned to whole multiples of the interval measured from the
   * Unix epoch (1970-01-01T00:00:00Z) and computed entirely in UTC, so the
   * result stays consistent with the UTC `.toISOString()` returned here and
   * with the SQL `DATE_TRUNC` that produced the input. Working purely in epoch
   * milliseconds also avoids the previous local-time `getFullYear()`/`setDate()`
   * arithmetic, which mistook "days since the epoch" for "day of year" and
   * projected multi-day buckets (e.g. the 90d view) decades into the future.
   */
  private static roundToBucket(
    timestamp: string,
    intervalMinutes: number,
  ): string {
    const intervalMs = intervalMinutes * 60 * 1000;
    const ms = new Date(timestamp).getTime();
    const rounded = Math.floor(ms / intervalMs) * intervalMs;
    return new Date(rounded).toISOString();
  }

  /**
   * Group time series data by custom bucket intervals.
   * The groupByField parameter specifies which field to include in the bucket key
   * to preserve grouping dimensions (e.g., model, teamId, agentId).
   */
  static groupTimeSeries<T extends StatisticsTimeSeriesData>(
    timeSeriesData: T[],
    timeframe: StatisticsTimeFrame,
    groupByField: keyof T,
  ): T[] {
    const intervalMinutes = StatisticsModel.getBucketIntervalMinutes(timeframe);

    // If the interval is standard (60 minutes or more), no custom grouping needed.
    // Still coerce numeric fields since PostgreSQL DOUBLE PRECISION / DECIMAL
    // values are returned as strings by node-postgres, which causes Zod schema
    // validation failures (z.number() rejects string values).
    if (intervalMinutes >= 60 && timeframe !== "7d" && timeframe !== "90d") {
      return timeSeriesData.map((row) => ({
        ...row,
        requests: Number(row.requests) || 0,
        inputTokens: Number(row.inputTokens) || 0,
        outputTokens: Number(row.outputTokens) || 0,
        cost: Number(row.cost) || 0,
        ...("cacheReadTokens" in row
          ? {
              cacheReadTokens:
                Number((row as { cacheReadTokens: unknown }).cacheReadTokens) ||
                0,
            }
          : {}),
      }));
    }

    // Group by custom intervals, preserving the groupBy dimension
    const grouped = new Map<string, T>();

    for (const row of timeSeriesData) {
      const timeBucketKey = StatisticsModel.roundToBucket(
        row.timeBucket,
        intervalMinutes,
      );

      // Include the groupBy field in the key to preserve separate entries per entity
      const groupValue = String(row[groupByField] ?? "unknown");
      const bucketKey = `${groupValue}:${timeBucketKey}`;

      if (!grouped.has(bucketKey)) {
        grouped.set(bucketKey, {
          ...row,
          timeBucket: timeBucketKey,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          // Reset before accumulating; the `...row` spread would otherwise leave
          // the first row's value in place and the merge would never sum it.
          ...("cacheReadTokens" in row ? { cacheReadTokens: 0 } : {}),
        } as T);
      }

      const existing = grouped.get(bucketKey);
      if (!existing) continue;

      existing.requests += Number(row.requests) || 0;
      existing.inputTokens += Number(row.inputTokens) || 0;
      existing.outputTokens += Number(row.outputTokens) || 0;
      // Aggregate cost (for statistics that include stored cost from interactions)
      if ("cost" in row && "cost" in existing) {
        (existing as { cost: number }).cost +=
          Number((row as { cost: number }).cost) || 0;
      }
      // Aggregate cache-read tokens (present only on model/agent series)
      if ("cacheReadTokens" in row && "cacheReadTokens" in existing) {
        (existing as { cacheReadTokens: number }).cacheReadTokens +=
          Number((row as { cacheReadTokens: number }).cacheReadTokens) || 0;
      }
    }

    return Array.from(grouped.values()).sort(
      (a, b) =>
        new Date(a.timeBucket).getTime() - new Date(b.timeBucket).getTime(),
    );
  }

  /**
   * Get team statistics
   */
  static async getTeamStatistics(
    timeframe: StatisticsTimeFrame,
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<TeamStatistics[]> {
    const interval = StatisticsModel.getTimeframeInterval(timeframe);
    const timeBucket = StatisticsModel.getTimeBucket(timeframe);

    // Get accessible agent IDs for users that are not agent admins
    let accessibleAgentIds: string[] = [];
    if (userId && !isAgentAdmin) {
      accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        false,
      );
      if (accessibleAgentIds.length === 0) {
        return [];
      }
    }

    // Base query for team statistics
    // Use stored cost from interactions instead of recalculating with average prices
    const query = db
      .select({
        teamId: schema.teamsTable.id,
        teamName: schema.teamsTable.name,
        timeBucket: sql<string>`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
        requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
        inputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.inputTokens}), 0) AS INTEGER)`,
        outputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.outputTokens}), 0) AS INTEGER)`,
        // Billed spend: subscription-fulfilled traffic incurs no per-token
        // charge, so its list-price `cost` is excluded from the reported total.
        cost: billedSum(schema.interactionsTable.cost, "DOUBLE PRECISION"),
      })
      .from(schema.interactionsTable)
      .innerJoin(
        schema.agentsTable,
        and(
          eq(schema.interactionsTable.profileId, schema.agentsTable.id),
          notDeleted(schema.agentsTable),
        ),
      )
      .innerJoin(
        schema.agentTeamsTable,
        eq(schema.agentsTable.id, schema.agentTeamsTable.agentId),
      )
      .innerJoin(
        schema.teamsTable,
        eq(schema.agentTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(
        and(
          ...(interval
            ? [
                gte(
                  schema.interactionsTable.createdAt,
                  sql`NOW() - INTERVAL ${sql.raw(`'${interval}'`)}`,
                ),
              ]
            : (() => {
                const customRange =
                  StatisticsModel.parseCustomTimeframe(timeframe);
                return customRange
                  ? [
                      gte(
                        schema.interactionsTable.createdAt,
                        customRange.startTime,
                      ),
                      lte(
                        schema.interactionsTable.createdAt,
                        customRange.endTime,
                      ),
                    ]
                  : [];
              })()),
          ...(accessibleAgentIds.length > 0
            ? [inArray(schema.agentsTable.id, accessibleAgentIds)]
            : []),
        ),
      )
      .groupBy(
        schema.teamsTable.id,
        schema.teamsTable.name,
        sql`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
      )
      .orderBy(
        sql`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
      );

    const rawTimeSeriesData = await query;

    const timeSeriesData = StatisticsModel.groupTimeSeries(
      rawTimeSeriesData,
      timeframe,
      "teamId",
    );

    // Get team member counts
    const teamMemberCounts = await db
      .select({
        teamId: schema.teamsTable.id,
        memberCount: sql<number>`CAST(COUNT(DISTINCT ${schema.teamMembersTable.userId}) AS INTEGER)`,
      })
      .from(schema.teamsTable)
      .leftJoin(
        schema.teamMembersTable,
        eq(schema.teamsTable.id, schema.teamMembersTable.teamId),
      )
      .groupBy(schema.teamsTable.id);

    // Get agent counts per team
    const teamAgentCounts = await db
      .select({
        teamId: schema.teamsTable.id,
        agentCount: sql<number>`CAST(COUNT(DISTINCT ${schema.agentTeamsTable.agentId}) AS INTEGER)`,
      })
      .from(schema.teamsTable)
      .leftJoin(
        schema.agentTeamsTable,
        eq(schema.teamsTable.id, schema.agentTeamsTable.teamId),
      )
      .groupBy(schema.teamsTable.id);

    // Aggregate data by team
    const teamMap = new Map<string, TeamStatistics>();

    for (const row of timeSeriesData) {
      // Use stored cost from interactions (already calculated per-model)
      const cost = Number(row.cost) || 0;

      if (!teamMap.has(row.teamId)) {
        const memberCount =
          teamMemberCounts.find((t) => t.teamId === row.teamId)?.memberCount ||
          0;
        const agentCount =
          teamAgentCounts.find((t) => t.teamId === row.teamId)?.agentCount || 0;

        teamMap.set(row.teamId, {
          teamId: row.teamId,
          teamName: row.teamName,
          members: memberCount,
          agents: agentCount,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          timeSeries: [],
        });
      }

      const team = teamMap.get(row.teamId);
      if (!team) continue;
      team.requests += Number(row.requests);
      team.inputTokens += Number(row.inputTokens);
      team.outputTokens += Number(row.outputTokens);
      team.cost += cost;
      team.timeSeries.push({
        timestamp: row.timeBucket,
        value: cost,
      });
    }

    return Array.from(teamMap.values());
  }

  /**
   * Get agent statistics
   */
  static async getAgentStatistics(
    timeframe: StatisticsTimeFrame,
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<AgentStatistics[]> {
    const interval = StatisticsModel.getTimeframeInterval(timeframe);
    const timeBucket = StatisticsModel.getTimeBucket(timeframe);

    // Get accessible agent IDs for users that are non-agent admins
    let accessibleAgentIds: string[] = [];
    if (userId && !isAgentAdmin) {
      accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        false,
      );
      if (accessibleAgentIds.length === 0) {
        return [];
      }
    }

    // Use stored cost from interactions instead of recalculating with average prices
    const query = db
      .select({
        agentId: schema.agentsTable.id,
        agentName: schema.agentsTable.name,
        agentType: schema.agentsTable.agentType,
        teamName: schema.teamsTable.name,
        timeBucket: sql<string>`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
        requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
        inputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.inputTokens}), 0) AS INTEGER)`,
        outputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.outputTokens}), 0) AS INTEGER)`,
        cacheReadTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.cacheReadTokens}), 0) AS INTEGER)`,
        // Billed spend: subscription-fulfilled traffic incurs no per-token
        // charge, so its list-price `cost` is excluded from the reported total.
        cost: billedSum(schema.interactionsTable.cost, "DOUBLE PRECISION"),
      })
      .from(schema.interactionsTable)
      .innerJoin(
        schema.agentsTable,
        and(
          eq(schema.interactionsTable.profileId, schema.agentsTable.id),
          notDeleted(schema.agentsTable),
        ),
      )
      .leftJoin(
        schema.agentTeamsTable,
        eq(schema.agentsTable.id, schema.agentTeamsTable.agentId),
      )
      .leftJoin(
        schema.teamsTable,
        eq(schema.agentTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(
        and(
          ...(interval
            ? [
                gte(
                  schema.interactionsTable.createdAt,
                  sql`NOW() - INTERVAL ${sql.raw(`'${interval}'`)}`,
                ),
              ]
            : (() => {
                const customRange =
                  StatisticsModel.parseCustomTimeframe(timeframe);
                return customRange
                  ? [
                      gte(
                        schema.interactionsTable.createdAt,
                        customRange.startTime,
                      ),
                      lte(
                        schema.interactionsTable.createdAt,
                        customRange.endTime,
                      ),
                    ]
                  : [];
              })()),
          ...(accessibleAgentIds.length > 0
            ? [inArray(schema.agentsTable.id, accessibleAgentIds)]
            : []),
        ),
      )
      .groupBy(
        schema.agentsTable.id,
        schema.agentsTable.name,
        schema.agentsTable.agentType,
        schema.teamsTable.name,
        sql`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
      )
      .orderBy(
        sql`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
      );

    const rawTimeSeriesData = await query;

    const timeSeriesData = StatisticsModel.groupTimeSeries(
      rawTimeSeriesData,
      timeframe,
      "agentId",
    );

    // Aggregate data by agent
    const agentMap = new Map<string, AgentStatistics>();

    for (const row of timeSeriesData) {
      // Use stored cost from interactions (already calculated per-model)
      const cost = Number(row.cost) || 0;

      if (!agentMap.has(row.agentId)) {
        agentMap.set(row.agentId, {
          agentId: row.agentId,
          agentName: row.agentName,
          agentType: row.agentType,
          teamName: row.teamName || "No Team",
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cost: 0,
          timeSeries: [],
        });
      }

      const agent = agentMap.get(row.agentId);
      if (!agent) continue;
      agent.requests += Number(row.requests);
      agent.inputTokens += Number(row.inputTokens);
      agent.outputTokens += Number(row.outputTokens);
      agent.cacheReadTokens += Number(row.cacheReadTokens) || 0;
      agent.cost += cost;
      agent.timeSeries.push({
        timestamp: row.timeBucket,
        value: cost,
      });
    }

    return Array.from(agentMap.values());
  }

  /**
   * Get model statistics
   */
  static async getModelStatistics(
    timeframe: StatisticsTimeFrame,
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<ModelStatistics[]> {
    const interval = StatisticsModel.getTimeframeInterval(timeframe);
    const timeBucket = StatisticsModel.getTimeBucket(timeframe);

    // Get accessible agent IDs for users that are non-agent admins
    let accessibleAgentIds: string[] = [];
    if (userId && !isAgentAdmin) {
      accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return [];
      }
    }

    // Use stored cost from interactions instead of recalculating with average prices
    const query = db
      .select({
        model: schema.interactionsTable.model,
        timeBucket: sql<string>`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
        requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
        inputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.inputTokens}), 0) AS INTEGER)`,
        outputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.outputTokens}), 0) AS INTEGER)`,
        cacheReadTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.cacheReadTokens}), 0) AS INTEGER)`,
        // Billed spend: subscription-fulfilled traffic incurs no per-token
        // charge, so its list-price `cost` is excluded from the reported total.
        cost: billedSum(schema.interactionsTable.cost, "DOUBLE PRECISION"),
      })
      .from(schema.interactionsTable)
      .innerJoin(
        schema.agentsTable,
        and(
          eq(schema.interactionsTable.profileId, schema.agentsTable.id),
          notDeleted(schema.agentsTable),
        ),
      )
      .where(
        and(
          ...(interval
            ? [
                gte(
                  schema.interactionsTable.createdAt,
                  sql`NOW() - INTERVAL ${sql.raw(`'${interval}'`)}`,
                ),
              ]
            : (() => {
                const customRange =
                  StatisticsModel.parseCustomTimeframe(timeframe);
                return customRange
                  ? [
                      gte(
                        schema.interactionsTable.createdAt,
                        customRange.startTime,
                      ),
                      lte(
                        schema.interactionsTable.createdAt,
                        customRange.endTime,
                      ),
                    ]
                  : [];
              })()),
          ...(accessibleAgentIds.length > 0
            ? [inArray(schema.agentsTable.id, accessibleAgentIds)]
            : []),
        ),
      )
      .groupBy(
        schema.interactionsTable.model,
        sql`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
      )
      .orderBy(
        sql`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
      );

    const rawTimeSeriesData = await query;
    const timeSeriesData = StatisticsModel.groupTimeSeries(
      rawTimeSeriesData,
      timeframe,
      "model",
    );

    // Aggregate data by model
    const modelMap = new Map<string, ModelStatistics>();
    let totalCost = 0;

    for (const row of timeSeriesData) {
      if (!row.model) continue;

      // Use stored cost from interactions (already calculated per-model)
      const cost = Number(row.cost) || 0;

      totalCost += cost;

      if (!modelMap.has(row.model)) {
        modelMap.set(row.model, {
          model: row.model,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cost: 0,
          percentage: 0,
          timeSeries: [],
        });
      }

      const model = modelMap.get(row.model);
      if (!model) continue;
      model.requests += Number(row.requests);
      model.inputTokens += Number(row.inputTokens);
      model.outputTokens += Number(row.outputTokens);
      model.cacheReadTokens += Number(row.cacheReadTokens) || 0;
      model.cost += cost;
      model.timeSeries.push({
        timestamp: row.timeBucket,
        value: cost,
      });
    }

    // Calculate percentages
    const models = Array.from(modelMap.values());
    models.forEach((model) => {
      model.percentage = totalCost > 0 ? (model.cost / totalCost) * 100 : 0;
    });

    return models;
  }

  /**
   * Per-user usage for adoption reporting.
   *
   * Differs from the sibling team/agent/model aggregations in three ways, all
   * forced by user cardinality: an org has tens of teams and models but can
   * have thousands of users, so returning every entity with a full time series
   * in one payload does not scale.
   *
   * 1. Totals are paginated and sorted in SQL; only the requested page is
   *    returned.
   * 2. The time series is opt-in AND scoped to the page's users, so the
   *    response is bounded by `limit * buckets` rather than `users * buckets`.
   * 3. The per-model cut is opt-in and likewise page-scoped.
   *
   * Rows with a NULL `user_id` (unattributed traffic — e.g. a shared provider
   * key with no user context) are excluded by the join, so totals here are
   * deliberately <= org-wide totals.
   */
  static async getUserStatistics(params: {
    timeframe: StatisticsTimeFrame;
    pagination: PaginationQuery;
    sortBy: UserStatisticsSortBy;
    sortDirection: SortDirection;
    includeTimeSeries: boolean;
    includeModels: boolean;
    /** Caller, used for agent-access scoping. */
    requestingUserId?: string;
    isAgentAdmin?: boolean;
    /**
     * When false the caller may only see their own usage. Per-user usage is
     * employee-level data, so it is gated more tightly than the aggregate
     * team/model views.
     */
    canReadAllUsers: boolean;
  }): Promise<PaginatedResult<UserStatistics>> {
    const {
      timeframe,
      pagination,
      sortBy,
      sortDirection,
      includeTimeSeries,
      includeModels,
      requestingUserId,
      isAgentAdmin,
      canReadAllUsers,
    } = params;

    // Scope to agents the caller can see, matching the sibling statistics
    // aggregations.
    const scopeConditions: SQL[] = [
      ...StatisticsModel.timeframeConditions(timeframe),
    ];

    if (requestingUserId && !isAgentAdmin) {
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        requestingUserId,
        false,
      );
      if (accessibleAgentIds.length === 0) {
        return createPaginatedResult([], 0, pagination);
      }
      scopeConditions.push(
        inArray(schema.interactionsTable.profileId, accessibleAgentIds),
      );
    }

    // Without permission to read the roster, a caller sees only themselves.
    if (!canReadAllUsers) {
      if (!requestingUserId) {
        return createPaginatedResult([], 0, pagination);
      }
      scopeConditions.push(
        eq(schema.interactionsTable.userId, requestingUserId),
      );
    }

    const whereClause = and(...scopeConditions);

    const totalTokensExpr = sql<number>`COALESCE(SUM(${schema.interactionsTable.inputTokens}), 0) + COALESCE(SUM(${schema.interactionsTable.outputTokens}), 0)`;
    const billedCostExpr = billedSum(
      schema.interactionsTable.cost,
      "DOUBLE PRECISION",
    );

    const sortExpr = {
      totalTokens: totalTokensExpr,
      requests: sql`COUNT(*)`,
      billedCost: billedCostExpr,
      lastActiveAt: sql`MAX(${schema.interactionsTable.createdAt})`,
      userName: sql`${schema.usersTable.name}`,
    }[sortBy];

    // PHASE 1 — paginated per-user totals.
    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          userId: schema.usersTable.id,
          userName: schema.usersTable.name,
          userEmail: schema.usersTable.email,
          requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
          inputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.inputTokens}), 0) AS INTEGER)`,
          outputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.outputTokens}), 0) AS INTEGER)`,
          cacheReadTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.cacheReadTokens}), 0) AS INTEGER)`,
          totalTokens: sql<number>`CAST(${totalTokensExpr} AS INTEGER)`,
          billedCost: billedCostExpr,
          subscriptionCost: subscriptionCostSum("DOUBLE PRECISION"),
          activeDays: sql<number>`CAST(COUNT(DISTINCT DATE(${schema.interactionsTable.createdAt})) AS INTEGER)`,
          lastActiveAt: sql<string>`MAX(${schema.interactionsTable.createdAt})`,
        })
        .from(schema.interactionsTable)
        .innerJoin(
          schema.usersTable,
          eq(schema.interactionsTable.userId, schema.usersTable.id),
        )
        .where(whereClause)
        .groupBy(
          schema.usersTable.id,
          schema.usersTable.name,
          schema.usersTable.email,
        )
        .orderBy(sortDirection === "asc" ? asc(sortExpr) : desc(sortExpr))
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({
          total: sql<number>`CAST(COUNT(DISTINCT ${schema.interactionsTable.userId}) AS INTEGER)`,
        })
        .from(schema.interactionsTable)
        .innerJoin(
          schema.usersTable,
          eq(schema.interactionsTable.userId, schema.usersTable.id),
        )
        .where(whereClause),
    ]);

    const pageUserIds = rows.map((row) => row.userId);

    // PHASE 2 — page-scoped enrichment. Skipped entirely when the page is empty
    // so an empty `inArray` never reaches SQL.
    const [timeSeriesByUser, modelsByUser] = await Promise.all([
      includeTimeSeries && pageUserIds.length > 0
        ? StatisticsModel.getUserTimeSeries({
            timeframe,
            userIds: pageUserIds,
            whereClause,
          })
        : Promise.resolve(new Map<string, StatisticsTimeSeriesPoint[]>()),
      includeModels && pageUserIds.length > 0
        ? StatisticsModel.getUserModelBreakdown({
            userIds: pageUserIds,
            whereClause,
          })
        : Promise.resolve(new Map<string, UserModelUsage[]>()),
    ]);

    const data = rows.map((row) => ({
      userId: row.userId,
      userName: row.userName,
      userEmail: row.userEmail,
      requests: Number(row.requests) || 0,
      inputTokens: Number(row.inputTokens) || 0,
      outputTokens: Number(row.outputTokens) || 0,
      cacheReadTokens: Number(row.cacheReadTokens) || 0,
      totalTokens: Number(row.totalTokens) || 0,
      billedCost: Number(row.billedCost) || 0,
      subscriptionCost: Number(row.subscriptionCost) || 0,
      activeDays: Number(row.activeDays) || 0,
      lastActiveAt: row.lastActiveAt
        ? new Date(row.lastActiveAt).toISOString()
        : null,
      ...(includeModels
        ? { models: modelsByUser.get(row.userId) ?? [] }
        : {}),
      ...(includeTimeSeries
        ? { timeSeries: timeSeriesByUser.get(row.userId) ?? [] }
        : {}),
    }));

    return createPaginatedResult(data, Number(total) || 0, pagination);
  }

  /**
   * Get overview statistics
   */
  static async getOverviewStatistics(
    timeframe: StatisticsTimeFrame,
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<OverviewStatistics> {
    const [teamStats, agentStats, modelStats] = await Promise.all([
      StatisticsModel.getTeamStatistics(timeframe, userId, isAgentAdmin),
      StatisticsModel.getAgentStatistics(timeframe, userId, isAgentAdmin),
      StatisticsModel.getModelStatistics(timeframe, userId, isAgentAdmin),
    ]);

    const totalRequests = teamStats.reduce(
      (sum, team) => sum + team.requests,
      0,
    );
    const totalTokens = teamStats.reduce(
      (sum, team) => sum + team.inputTokens + team.outputTokens,
      0,
    );
    const totalCost = teamStats.reduce((sum, team) => sum + team.cost, 0);

    const topTeam =
      teamStats.length > 0
        ? teamStats.reduce((top, team) =>
            team.cost > (top?.cost || 0) ? team : top,
          )?.teamName || ""
        : "";

    const topAgent =
      agentStats.length > 0
        ? agentStats.reduce((top, agent) =>
            agent.cost > (top?.cost || 0) ? agent : top,
          )?.agentName || ""
        : "";

    const topModel =
      modelStats.length > 0
        ? modelStats.reduce((top, model) =>
            model.cost > (top?.cost || 0) ? model : top,
          )?.model || ""
        : "";

    return {
      totalRequests,
      totalTokens,
      totalCost,
      topTeam,
      topAgent,
      topModel,
    };
  }

  /**
   * Get cost savings statistics
   */
  static async getCostSavingsStatistics(
    timeframe: StatisticsTimeFrame,
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<CostSavingsStatistics> {
    const interval = StatisticsModel.getTimeframeInterval(timeframe);
    const timeBucket = StatisticsModel.getTimeBucket(timeframe);

    // Get accessible agent IDs for users that are non-agent admins
    let accessibleAgentIds: string[] = [];
    if (userId && !isAgentAdmin) {
      accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return {
          totalBaselineCost: 0,
          totalActualCost: 0,
          totalSavings: 0,
          totalSubscriptionCost: 0,
          totalOptimizationSavings: 0,
          totalToonSavings: 0,
          totalCacheSavings: 0,
          timeSeries: [],
        };
      }
    }

    const query = db
      .select({
        timeBucket: sql<string>`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
        // All cost/savings figures are billed (metered) only: optimization,
        // TOON, and cache savings reflect money actually spent. Subscription
        // traffic is reported separately as its would-be list-price cost, never
        // as an optimization saving.
        baselineCost: billedSum(
          schema.interactionsTable.baselineCost,
          "DECIMAL",
        ),
        actualCost: billedSum(schema.interactionsTable.cost, "DECIMAL"),
        toonSavings: billedSum(
          schema.interactionsTable.toonCostSavings,
          "DECIMAL",
        ),
        cacheSavings: billedSum(
          schema.interactionsTable.cacheSavings,
          "DECIMAL",
        ),
        subscriptionCost: subscriptionCostSum("DECIMAL"),
      })
      .from(schema.interactionsTable)
      .innerJoin(
        schema.agentsTable,
        and(
          eq(schema.interactionsTable.profileId, schema.agentsTable.id),
          notDeleted(schema.agentsTable),
        ),
      )
      .where(
        and(
          ...(interval
            ? [
                gte(
                  schema.interactionsTable.createdAt,
                  sql`NOW() - INTERVAL ${sql.raw(`'${interval}'`)}`,
                ),
              ]
            : (() => {
                const customRange =
                  StatisticsModel.parseCustomTimeframe(timeframe);
                return customRange
                  ? [
                      gte(
                        schema.interactionsTable.createdAt,
                        customRange.startTime,
                      ),
                      lte(
                        schema.interactionsTable.createdAt,
                        customRange.endTime,
                      ),
                    ]
                  : [];
              })()),
          ...(accessibleAgentIds.length > 0
            ? [inArray(schema.agentsTable.id, accessibleAgentIds)]
            : []),
        ),
      )
      .groupBy(
        sql`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
      )
      .orderBy(
        sql`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
      );

    const rawTimeSeriesData = await query;

    // Custom grouping for cost savings data
    interface CostSavingsRow {
      timeBucket: string;
      baselineCost: number;
      actualCost: number;
      toonSavings: number;
      cacheSavings: number;
      subscriptionCost: number;
    }

    const intervalMinutes = StatisticsModel.getBucketIntervalMinutes(timeframe);

    // Group by custom intervals if needed
    const grouped = new Map<string, CostSavingsRow>();

    for (const row of rawTimeSeriesData) {
      const bucketKey =
        intervalMinutes >= 60 && timeframe !== "7d" && timeframe !== "90d"
          ? row.timeBucket
          : StatisticsModel.roundToBucket(row.timeBucket, intervalMinutes);

      if (!grouped.has(bucketKey)) {
        grouped.set(bucketKey, {
          timeBucket: bucketKey,
          baselineCost: 0,
          actualCost: 0,
          toonSavings: 0,
          cacheSavings: 0,
          subscriptionCost: 0,
        });
      }

      const existing = grouped.get(bucketKey);
      if (!existing) continue;

      existing.baselineCost += Number(row.baselineCost);
      existing.actualCost += Number(row.actualCost);
      existing.toonSavings += Number(row.toonSavings);
      existing.cacheSavings += Number(row.cacheSavings);
      existing.subscriptionCost += Number(row.subscriptionCost);
    }

    const timeSeriesData = Array.from(grouped.values()).sort(
      (a, b) =>
        new Date(a.timeBucket).getTime() - new Date(b.timeBucket).getTime(),
    );

    // Calculate totals and build time series
    let totalBaselineCost = 0;
    let totalActualCost = 0;
    let totalOptimizationSavings = 0;
    let totalToonSavings = 0;
    let totalCacheSavings = 0;
    let totalSubscriptionCost = 0;

    const timeSeries = timeSeriesData.map((row) => {
      // `row.actualCost` is SUM(interactions.cost) over METERED rows only: the
      // real billed spend. It already reflects every applied optimization — the
      // cheaper model, TOON's reduced billed token count, and the prompt-cache
      // discount — so it is the true "Actual Cost". Subscription-fulfilled
      // traffic is excluded here and surfaced separately as `subscriptionCost`.
      const actualCost = Number(row.actualCost);
      // Would-be list-price cost of subscription-covered traffic (not billed).
      const subscriptionCost = Number(row.subscriptionCost);
      // `row.baselineCost` is SUM(interactions.baseline_cost): the same usage
      // priced at the original (pre-optimization) model.
      const baselineModelCost = Number(row.baselineCost);
      const toonSavings = Number(row.toonSavings);
      const cacheSavings = Number(row.cacheSavings);

      // Savings from optimization rules alone: identical token usage, original
      // model vs. the model actually used.
      const optimizationSavings = baselineModelCost - actualCost;

      // "Non-optimized" cost: what the request would have cost with none of the
      // optimizations applied (original model, uncompressed tokens, no cache).
      // Adding each realized saving back onto the real spend keeps this line
      // exactly `optimizationSavings + toonSavings + cacheSavings` above the
      // actual-cost line, so the savings-breakdown chart reconciles with the
      // gap shown in the non-optimized-vs-actual chart.
      const baselineCost =
        actualCost + optimizationSavings + toonSavings + cacheSavings;

      totalBaselineCost += baselineCost;
      totalActualCost += actualCost;
      totalOptimizationSavings += optimizationSavings;
      totalToonSavings += toonSavings;
      totalCacheSavings += cacheSavings;
      totalSubscriptionCost += subscriptionCost;

      return {
        timestamp: row.timeBucket,
        baselineCost,
        actualCost,
        optimizationSavings,
        toonSavings,
        cacheSavings,
        subscriptionCost,
      };
    });

    const totalSavings = totalBaselineCost - totalActualCost;

    return {
      totalBaselineCost,
      totalActualCost,
      totalSavings,
      totalSubscriptionCost,
      totalOptimizationSavings,
      totalToonSavings,
      totalCacheSavings,
      timeSeries,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * WHERE conditions restricting `interactions` to a timeframe, covering both
   * the relative presets and `custom:<start>_<end>` ranges.
   */
  private static timeframeConditions(timeframe: StatisticsTimeFrame): SQL[] {
    const interval = StatisticsModel.getTimeframeInterval(timeframe);

    if (interval) {
      return [
        gte(
          schema.interactionsTable.createdAt,
          sql`NOW() - INTERVAL ${sql.raw(`'${interval}'`)}`,
        ),
      ];
    }

    const customRange = StatisticsModel.parseCustomTimeframe(timeframe);
    if (!customRange) {
      return [];
    }
    return [
      gte(schema.interactionsTable.createdAt, customRange.startTime),
      lte(schema.interactionsTable.createdAt, customRange.endTime),
    ];
  }

  /**
   * Cost time series for a bounded set of users, keyed by user id. Reuses the
   * same bucketing as the other statistics views so the chart shapes match.
   */
  private static async getUserTimeSeries(params: {
    timeframe: StatisticsTimeFrame;
    userIds: string[];
    whereClause: SQL | undefined;
  }): Promise<Map<string, StatisticsTimeSeriesPoint[]>> {
    const { timeframe, userIds, whereClause } = params;
    const timeBucket = StatisticsModel.getTimeBucket(timeframe);

    const rawRows = await db
      .select({
        userId: schema.interactionsTable.userId,
        timeBucket: sql<string>`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
        requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
        inputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.inputTokens}), 0) AS INTEGER)`,
        outputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.outputTokens}), 0) AS INTEGER)`,
        cost: billedSum(schema.interactionsTable.cost, "DOUBLE PRECISION"),
      })
      .from(schema.interactionsTable)
      .where(
        and(whereClause, inArray(schema.interactionsTable.userId, userIds)),
      )
      .groupBy(
        schema.interactionsTable.userId,
        sql`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
      )
      .orderBy(
        sql`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
      );

    const bucketed = StatisticsModel.groupTimeSeries(
      // `user_id` is non-null here: the caller's WHERE already restricts to the
      // page's user ids, which come from an inner join on users.
      rawRows as StatisticsUserTimeSeriesData[],
      timeframe,
      "userId",
    );

    const byUser = new Map<string, StatisticsTimeSeriesPoint[]>();
    for (const row of bucketed) {
      const points = byUser.get(row.userId) ?? [];
      points.push({ timestamp: row.timeBucket, value: Number(row.cost) || 0 });
      byUser.set(row.userId, points);
    }
    return byUser;
  }

  /**
   * Per-model usage for a bounded set of users, keyed by user id, ordered
   * heaviest model first. Interactions with no recorded model are skipped
   * rather than bucketed under a placeholder name.
   */
  private static async getUserModelBreakdown(params: {
    userIds: string[];
    whereClause: SQL | undefined;
  }): Promise<Map<string, UserModelUsage[]>> {
    const { userIds, whereClause } = params;

    const rows = await db
      .select({
        userId: schema.interactionsTable.userId,
        model: schema.interactionsTable.model,
        requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
        inputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.inputTokens}), 0) AS INTEGER)`,
        outputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.outputTokens}), 0) AS INTEGER)`,
        cacheReadTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.cacheReadTokens}), 0) AS INTEGER)`,
        billedCost: billedSum(schema.interactionsTable.cost, "DOUBLE PRECISION"),
        subscriptionCost: subscriptionCostSum("DOUBLE PRECISION"),
      })
      .from(schema.interactionsTable)
      .where(
        and(
          whereClause,
          inArray(schema.interactionsTable.userId, userIds),
          isNotNull(schema.interactionsTable.model),
        ),
      )
      .groupBy(schema.interactionsTable.userId, schema.interactionsTable.model)
      .orderBy(
        desc(
          sql`COALESCE(SUM(${schema.interactionsTable.inputTokens}), 0) + COALESCE(SUM(${schema.interactionsTable.outputTokens}), 0)`,
        ),
      );

    const byUser = new Map<string, UserModelUsage[]>();
    for (const row of rows) {
      if (!row.userId || !row.model) continue;
      const entries = byUser.get(row.userId) ?? [];
      entries.push({
        model: row.model,
        requests: Number(row.requests) || 0,
        inputTokens: Number(row.inputTokens) || 0,
        outputTokens: Number(row.outputTokens) || 0,
        cacheReadTokens: Number(row.cacheReadTokens) || 0,
        billedCost: Number(row.billedCost) || 0,
        subscriptionCost: Number(row.subscriptionCost) || 0,
      });
      byUser.set(row.userId, entries);
    }
    return byUser;
  }
}

// ─── Billing-mode-aware cost aggregates ─────────────────────────────────────
// An interaction's `cost` is the list-price estimate. "Billed spend" is that
// cost only for `metered` rows; `subscription` rows incur no per-token charge
// and contribute 0. The split is expressed as SQL aggregate FILTERs on
// billing_mode. billing_mode is intentionally not in the statistics covering
// index (adding it would require a write-blocking rebuild on a huge table — see
// the interactions schema), so the FILTER reads it from the heap.

/** SUM of an interaction cost column restricted to metered rows (billed spend). */
function billedSum(
  column: AnyColumn,
  cast: "DOUBLE PRECISION" | "DECIMAL",
): SQL<number> {
  return sql<number>`CAST(COALESCE(SUM(${column}) FILTER (WHERE ${schema.interactionsTable.billingMode} = 'metered'), 0) AS ${sql.raw(cast)})`;
}

/** SUM of interaction `cost` restricted to subscription rows (would-be list-price cost). */
function subscriptionCostSum(
  cast: "DOUBLE PRECISION" | "DECIMAL",
): SQL<number> {
  return sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.cost}) FILTER (WHERE ${schema.interactionsTable.billingMode} = 'subscription'), 0) AS ${sql.raw(cast)})`;
}

export default StatisticsModel;
