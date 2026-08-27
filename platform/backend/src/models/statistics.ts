import {
  clientUsageLabelForExternalAgentId,
  getStatisticsBucketIntervalMinutes,
  type PaginationQuery,
  parseCustomStatisticsTimeframe,
  type StatisticsTimeFrame,
} from "@archestra/shared";
import {
  type AnyColumn,
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type {
  AgentStatistics,
  AppStatistics,
  AppStatisticsSortBy,
  ChatCostBaseline,
  CostSavingsStatistics,
  ModelStatistics,
  MyClientUsage,
  MyContextBucketId,
  MyStatistics,
  MyUsageBreakdown,
  OverviewStatistics,
  SkillStatistics,
  SkillStatisticsSortBy,
  SortDirection,
  StatisticsTimeSeriesData,
  StatisticsTimeSeriesPoint,
  StatisticsUserTimeSeriesData,
  TeamStatistics,
  UserModelUsage,
  UserStatistics,
  UserStatisticsSortBy,
} from "@/types";
import { isUuid } from "@/utils/uuid";
import AgentModel from "./agent";
import AgentTeamModel from "./agent-team";

class StatisticsModel {
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
      const customRange = parseCustomStatisticsTimeframe(timeframe);
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
    const intervalMinutes = getStatisticsBucketIntervalMinutes(timeframe);

    // Nothing to regroup when SQL already truncated to the final bucket width.
    // Still coerce numeric fields since PostgreSQL DOUBLE PRECISION / DECIMAL
    // values are returned as strings by node-postgres, which causes Zod schema
    // validation failures (z.number() rejects string values).
    if (!StatisticsModel.needsRebucketing(timeframe, intervalMinutes)) {
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
        inputTokens: tokenSum(schema.interactionsTable.inputTokens),
        outputTokens: tokenSum(schema.interactionsTable.outputTokens),
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
          ...StatisticsModel.timeframeConditions(timeframe),
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
        organizationId: schema.agentsTable.organizationId,
        teamName: schema.teamsTable.name,
        timeBucket: sql<string>`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
        requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
        inputTokens: tokenSum(schema.interactionsTable.inputTokens),
        outputTokens: tokenSum(schema.interactionsTable.outputTokens),
        cacheReadTokens: tokenSum(schema.interactionsTable.cacheReadTokens),
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
          ...StatisticsModel.timeframeConditions(timeframe),
          ...(accessibleAgentIds.length > 0
            ? [inArray(schema.agentsTable.id, accessibleAgentIds)]
            : []),
        ),
      )
      .groupBy(
        schema.agentsTable.id,
        schema.agentsTable.name,
        schema.agentsTable.agentType,
        schema.agentsTable.organizationId,
        schema.teamsTable.name,
        sql`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
      )
      .orderBy(
        sql`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
      );

    const rawTimeSeriesData = await StatisticsModel.collapseProxyRows(
      await query,
    );

    const timeSeriesData = StatisticsModel.groupTimeSeries(
      rawTimeSeriesData,
      timeframe,
      "agentId",
    );

    // Aggregate data by agent
    const agentMap = new Map<string, AgentStatistics>();
    // Rows collapsed onto the LLM Proxy above can repeat a bucket (one per
    // originating proxy row), so points are merged by timestamp rather than
    // appended — a series with a duplicate timestamp reads as whichever point
    // a consumer looks up first, not as the bucket's total.
    const seriesByAgent = new Map<string, Map<string, number>>();

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
        seriesByAgent.set(row.agentId, new Map());
      }

      const agent = agentMap.get(row.agentId);
      const series = seriesByAgent.get(row.agentId);
      if (!agent || !series) continue;
      agent.requests += Number(row.requests);
      agent.inputTokens += Number(row.inputTokens);
      agent.outputTokens += Number(row.outputTokens);
      agent.cacheReadTokens += Number(row.cacheReadTokens) || 0;
      agent.cost += cost;
      series.set(row.timeBucket, (series.get(row.timeBucket) ?? 0) + cost);
    }

    for (const agent of agentMap.values()) {
      agent.timeSeries = Array.from(
        seriesByAgent.get(agent.agentId) ?? [],
        ([timestamp, value]) => ({ timestamp, value }),
      )
        // Chronological regardless of the order the rows arrived in: buckets
        // are uniformly formatted within a response, so they sort as strings.
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
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
        inputTokens: tokenSum(schema.interactionsTable.inputTokens),
        outputTokens: tokenSum(schema.interactionsTable.outputTokens),
        cacheReadTokens: tokenSum(schema.interactionsTable.cacheReadTokens),
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
          ...StatisticsModel.timeframeConditions(timeframe),
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
          inputTokens: tokenSum(schema.interactionsTable.inputTokens),
          outputTokens: tokenSum(schema.interactionsTable.outputTokens),
          cacheReadTokens: tokenSum(schema.interactionsTable.cacheReadTokens),
          totalTokens: sql<number>`CAST(${totalTokensExpr} AS DOUBLE PRECISION)`,
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
      ...(includeModels ? { models: modelsByUser.get(row.userId) ?? [] } : {}),
      ...(includeTimeSeries
        ? { timeSeries: timeSeriesByUser.get(row.userId) ?? [] }
        : {}),
    }));

    return createPaginatedResult(data, Number(total) || 0, pagination);
  }

  /**
   * The caller's own cost and usage.
   *
   * Separate from {@link getUserStatistics} rather than a self-scoped call into
   * it, for two reasons:
   *
   * - **Permission surface.** This is the one statistics view that requires no
   *   permission over other people's data, so its scope is a fixed
   *   `user_id = :me` predicate with no parameter that can widen it. Reusing the
   *   paginated per-user query would make "may I see everyone?" a runtime
   *   argument on the endpoint that exists precisely because the caller may not.
   * - **Scope.** `getUserStatistics` narrows to agents the caller can see, which
   *   is right when reading other people's usage through an agent-shaped lens.
   *   Applied to your own row it silently drops your own spend on an agent you
   *   have since lost access to, which reads as usage going missing. Your own
   *   interactions are yours regardless of which agent served them.
   *
   * Restricted to one organization, so a member of several sees this
   * organization's usage on this organization's page. Interactions whose agent
   * has been deleted (`profile_id` is ON DELETE SET NULL) name no organization
   * and are kept: they are still the caller's own spend, and dropping them would
   * under-report it.
   */
  static async getMyStatistics(params: {
    timeframe: StatisticsTimeFrame;
    userId: string;
    organizationId: string;
  }): Promise<MyStatistics> {
    const { timeframe, userId, organizationId } = params;

    const whereClause = and(
      ...StatisticsModel.timeframeConditions(timeframe),
      eq(schema.interactionsTable.userId, userId),
      ...StatisticsModel.organizationScopeSubqueryConditions(organizationId),
    );

    const totalTokensExpr = sql<number>`COALESCE(SUM(${schema.interactionsTable.inputTokens}), 0) + COALESCE(SUM(${schema.interactionsTable.outputTokens}), 0)`;

    const [totals, timeSeriesByUser, modelsByUser] = await Promise.all([
      db
        .select({
          requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
          inputTokens: tokenSum(schema.interactionsTable.inputTokens),
          outputTokens: tokenSum(schema.interactionsTable.outputTokens),
          cacheReadTokens: tokenSum(schema.interactionsTable.cacheReadTokens),
          totalTokens: sql<number>`CAST(${totalTokensExpr} AS DOUBLE PRECISION)`,
          billedCost: billedSum(
            schema.interactionsTable.cost,
            "DOUBLE PRECISION",
          ),
          subscriptionCost: subscriptionCostSum("DOUBLE PRECISION"),
          activeDays: sql<number>`CAST(COUNT(DISTINCT DATE(${schema.interactionsTable.createdAt})) AS INTEGER)`,
          lastActiveAt: sql<
            string | null
          >`MAX(${schema.interactionsTable.createdAt})`,
        })
        .from(schema.interactionsTable)
        .where(whereClause),
      StatisticsModel.getUserTimeSeries({
        timeframe,
        userIds: [userId],
        whereClause,
      }),
      StatisticsModel.getUserModelBreakdown({
        userIds: [userId],
        whereClause,
      }),
    ]);

    // An aggregate with no GROUP BY always returns exactly one row, even over
    // zero interactions — the empty case is that row's zeros, not a missing row.
    const row = totals[0];

    return {
      requests: Number(row?.requests) || 0,
      inputTokens: Number(row?.inputTokens) || 0,
      outputTokens: Number(row?.outputTokens) || 0,
      cacheReadTokens: Number(row?.cacheReadTokens) || 0,
      totalTokens: Number(row?.totalTokens) || 0,
      billedCost: Number(row?.billedCost) || 0,
      subscriptionCost: Number(row?.subscriptionCost) || 0,
      activeDays: Number(row?.activeDays) || 0,
      lastActiveAt: row?.lastActiveAt
        ? new Date(row.lastActiveAt).toISOString()
        : null,
      models: modelsByUser.get(userId) ?? [],
      timeSeries: timeSeriesByUser.get(userId) ?? [],
    };
  }

  /**
   * The diagnostic cuts behind {@link getMyStatistics}: not how much the caller
   * spent but what shape of work produced it — the price band their tokens fell
   * into, the context sizes they ran at, and which sessions concentrated the
   * spend.
   *
   * Scoped exactly like {@link getMyStatistics} (own rows, one organization,
   * agent-deleted rows kept), and carries the same absence of any parameter
   * that could widen it beyond the caller.
   *
   * Cost here is *list price across both billing modes*, not billed spend. The
   * question this answers is "what consumed my tokens", and for anyone on a
   * flat-rate plan — which is precisely the heavy agentic user most likely to
   * ask it — billed spend is zero on every row and every share would be 0/0.
   * `billedCost` is returned alongside per session so the money view is still
   * available where it means something.
   */
  static async getMyUsageBreakdown(params: {
    timeframe: StatisticsTimeFrame;
    userId: string;
    organizationId: string;
    /** How many of the costliest sessions to name. */
    sessionLimit: number;
  }): Promise<MyUsageBreakdown> {
    const { timeframe, userId, organizationId, sessionLimit } = params;
    const interactions = schema.interactionsTable;

    const whereClause = and(
      ...StatisticsModel.timeframeConditions(timeframe),
      eq(interactions.userId, userId),
      ...StatisticsModel.organizationScopeSubqueryConditions(organizationId),
    );

    // Context size as the model saw it on that turn: fresh prompt tokens plus
    // whatever was replayed from cache. Output is excluded — it is produced by
    // the turn, not read by it.
    const contextSizeExpr = sql<number>`(COALESCE(${interactions.inputTokens}, 0) + COALESCE(${interactions.cacheReadTokens}, 0))`;
    // Bands are powers-of-two-ish around the sizes that actually change
    // behaviour on today's models, not even decades.
    const bucketExpr = sql<MyContextBucketId>`CASE
      WHEN ${contextSizeExpr} < 32000 THEN 'under32k'
      WHEN ${contextSizeExpr} < 128000 THEN 'under128k'
      WHEN ${contextSizeExpr} < 256000 THEN 'under256k'
      ELSE 'over256k'
    END`;
    // List price regardless of billing mode — see the doc comment.
    const listCostExpr = sql<number>`CAST(COALESCE(SUM(${interactions.cost}), 0) AS DOUBLE PRECISION)`;
    const tokensExpr = sql<number>`CAST(COALESCE(SUM(${interactions.inputTokens}), 0) + COALESCE(SUM(${interactions.outputTokens}), 0) AS DOUBLE PRECISION)`;

    const [[mix], buckets, sessions, clientRows] = await Promise.all([
      db
        .select({
          freshInputTokens: tokenSum(interactions.inputTokens),
          cacheReadTokens: tokenSum(interactions.cacheReadTokens),
          cacheWriteTokens: tokenSum(interactions.cacheWriteTokens),
          outputTokens: tokenSum(interactions.outputTokens),
          cacheCost: sql<number>`CAST(COALESCE(SUM(${interactions.cacheCost}), 0) AS DOUBLE PRECISION)`,
          cacheSavings: sql<number>`CAST(COALESCE(SUM(${interactions.cacheSavings}), 0) AS DOUBLE PRECISION)`,
          totalCost: listCostExpr,
          // Counted here rather than in a fourth query: the session cut groups
          // these rows away, so this is the only pass that still sees them.
          unsessionedRequests: sql<number>`CAST(COUNT(*) FILTER (WHERE ${interactions.sessionId} IS NULL) AS INTEGER)`,
        })
        .from(interactions)
        .where(whereClause),
      db
        .select({
          bucket: bucketExpr,
          requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
          tokens: tokensExpr,
          cost: listCostExpr,
        })
        .from(interactions)
        .where(whereClause)
        .groupBy(bucketExpr),
      db
        .select({
          sessionId: interactions.sessionId,
          requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
          tokens: tokensExpr,
          cost: listCostExpr,
          billedCost: billedSum(interactions.cost, "DOUBLE PRECISION"),
          startedAt: sql<string>`MIN(${interactions.createdAt})`,
          lastActiveAt: sql<string>`MAX(${interactions.createdAt})`,
        })
        .from(interactions)
        .where(and(whereClause, isNotNull(interactions.sessionId)))
        .groupBy(interactions.sessionId)
        .orderBy(desc(listCostExpr))
        .limit(sessionLimit),
      db
        .select({
          client: interactions.externalAgentId,
          lastActiveAt: sql<string>`MAX(${interactions.createdAt})`,
          requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
          inputTokens: tokenSum(interactions.inputTokens),
          outputTokens: tokenSum(interactions.outputTokens),
          cacheReadTokens: tokenSum(interactions.cacheReadTokens),
          billedCost: billedSum(interactions.cost, "DOUBLE PRECISION"),
          subscriptionCost: subscriptionCostSum("DOUBLE PRECISION"),
        })
        .from(interactions)
        .where(whereClause)
        .groupBy(interactions.externalAgentId),
    ]);

    const sessionIds = sessions
      .map(({ sessionId }) => sessionId)
      .filter((id): id is string => id !== null);

    // Phase 2, over the returned page only: what a session "is" — its dominant
    // model and client. Grouping on the pair and taking the most frequent one
    // keeps them consistent with each other, so a session is never labelled
    // with one client's name and another client's model.
    const labels = sessionIds.length
      ? await db
          .selectDistinctOn([interactions.sessionId], {
            sessionId: interactions.sessionId,
            model: interactions.model,
            client: interactions.externalAgentId,
          })
          .from(interactions)
          .where(and(whereClause, inArray(interactions.sessionId, sessionIds)))
          .groupBy(
            interactions.sessionId,
            interactions.model,
            interactions.externalAgentId,
          )
          .orderBy(interactions.sessionId, desc(sql`COUNT(*)`))
      : [];

    const labelBySession = new Map(
      labels.map(({ sessionId, model, client }) => [
        sessionId,
        { model, client },
      ]),
    );

    const clientAgentIds = [
      ...new Set(
        [
          ...clientRows.map(({ client }) => client),
          ...labels.map(({ client }) => client),
        ]
          .map(extractUsageClientAgentId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const clientAgentRows = clientAgentIds.length
      ? await db
          .select({ id: schema.agentsTable.id, name: schema.agentsTable.name })
          .from(schema.agentsTable)
          .where(inArray(schema.agentsTable.id, clientAgentIds))
      : [];
    const clientAgentNames = new Map(
      clientAgentRows.map(({ id, name }) => [id, name]),
    );

    const clientsByLabel = new Map<string | null, MyClientUsage>();
    for (const row of clientRows) {
      const client = formatUsageClient(row.client, clientAgentNames);
      const lastActiveAt = new Date(row.lastActiveAt).toISOString();
      const current = clientsByLabel.get(client) ?? {
        client,
        lastActiveAt,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        percentage: 0,
        billedCost: 0,
        subscriptionCost: 0,
      };
      current.requests += Number(row.requests) || 0;
      current.inputTokens += Number(row.inputTokens) || 0;
      current.outputTokens += Number(row.outputTokens) || 0;
      current.cacheReadTokens += Number(row.cacheReadTokens) || 0;
      current.totalTokens = current.inputTokens + current.outputTokens;
      current.billedCost += Number(row.billedCost) || 0;
      current.subscriptionCost += Number(row.subscriptionCost) || 0;
      if (lastActiveAt > current.lastActiveAt) {
        current.lastActiveAt = lastActiveAt;
      }
      clientsByLabel.set(client, current);
    }
    const clientTotalTokens = Array.from(clientsByLabel.values()).reduce(
      (sum, client) => sum + client.totalTokens,
      0,
    );
    const clients = Array.from(clientsByLabel.values())
      .map((client) => ({
        ...client,
        percentage:
          clientTotalTokens > 0
            ? (client.totalTokens / clientTotalTokens) * 100
            : 0,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    return {
      tokenMix: {
        freshInputTokens: Number(mix?.freshInputTokens) || 0,
        cacheReadTokens: Number(mix?.cacheReadTokens) || 0,
        cacheWriteTokens: Number(mix?.cacheWriteTokens) || 0,
        outputTokens: Number(mix?.outputTokens) || 0,
        cacheCost: Number(mix?.cacheCost) || 0,
        cacheSavings: Number(mix?.cacheSavings) || 0,
      },
      clients,
      contextBuckets: CONTEXT_BUCKET_ORDER.flatMap((bucket) => {
        const row = buckets.find((candidate) => candidate.bucket === bucket);
        return row
          ? [
              {
                bucket,
                requests: Number(row.requests) || 0,
                tokens: Number(row.tokens) || 0,
                cost: Number(row.cost) || 0,
              },
            ]
          : [];
      }),
      topSessions: sessions.flatMap((row) => {
        // Never null in practice — the query filters them out — but narrowing
        // here keeps the row and its id from drifting apart via a parallel array.
        const { sessionId } = row;
        if (sessionId === null) return [];
        const startedAt = new Date(row.startedAt);
        const lastActiveAt = new Date(row.lastActiveAt);
        return [
          {
            sessionId,
            requests: Number(row.requests) || 0,
            tokens: Number(row.tokens) || 0,
            cost: Number(row.cost) || 0,
            billedCost: Number(row.billedCost) || 0,
            startedAt: startedAt.toISOString(),
            lastActiveAt: lastActiveAt.toISOString(),
            durationMinutes: Math.max(
              0,
              Math.round(
                (lastActiveAt.getTime() - startedAt.getTime()) / 60_000,
              ),
            ),
            model: labelBySession.get(sessionId)?.model ?? null,
            client: formatUsageClient(
              labelBySession.get(sessionId)?.client ?? null,
              clientAgentNames,
            ),
          },
        ];
      }),
      totalCost: Number(mix?.totalCost) || 0,
      unsessionedRequests: Number(mix?.unsessionedRequests) || 0,
    };
  }

  /**
   * Per-MCP-App cost: what each app cost to build, and what it costs to run.
   *
   * Neither half is derivable from an interaction row alone, so each comes from
   * its own key:
   *
   * - **build** — the authoring turns are ordinary chat interactions, so they are
   *   found through `apps.authoring_session_id`, the LLM session id those turns
   *   were recorded under. That is a join on `interactions.session_id`, which is
   *   indexed together with `created_at`, so the timeframe filter still drives it.
   *   One session can author several apps; its spend is reported for each and
   *   `buildSessionAppCount` says so, rather than the number being quietly split.
   * - **runtime** — `archestra.llm.complete()` calls carry `interactions.app_id`,
   *   so an app's own LLM spend is a direct group-by. That column is deliberately
   *   unindexed (see the interactions schema), so this leans on the timeframe
   *   filter and reads it from the heap — acceptable for an analytics query, and
   *   the alternative is an index build that blocks the proxy's write path.
   * - **usage** — `mcp_tool_calls` is already keyed by app and indexed on it, so
   *   opens (`tools/list`, one per host opening the app) and tool calls come from
   *   there.
   *
   * Paginated, but sorted in memory rather than in SQL: the three cost sources
   * live in different tables under different keys, so no single sortable
   * expression exists without joining all of them for every app in the
   * organization. The org's app roster is read whole and then ordered, the same
   * fetch-all-then-slice the Apps list itself does — app cardinality is tens,
   * not thousands. If that ever stops holding, the roster query is the thing to
   * push the sort into.
   */
  static async getAppStatistics(params: {
    timeframe: StatisticsTimeFrame;
    organizationId: string;
    pagination: PaginationQuery;
    sortBy: AppStatisticsSortBy;
    sortDirection: SortDirection;
    /** App ids the caller may see; undefined means no scope restriction (admins). */
    accessibleAppIds?: string[];
  }): Promise<PaginatedResult<AppStatistics> & ChatCostBaseline> {
    const {
      timeframe,
      organizationId,
      pagination,
      sortBy,
      sortDirection,
      accessibleAppIds,
    } = params;

    if (accessibleAppIds !== undefined && accessibleAppIds.length === 0) {
      return {
        ...createPaginatedResult<AppStatistics>([], 0, pagination),
        chatBaselineCostPerSession: 0,
        chatBaselineSessions: 0,
      };
    }

    const appFilters = [
      eq(schema.appsTable.organizationId, organizationId),
      notDeleted(schema.appsTable),
      ...(accessibleAppIds
        ? [inArray(schema.appsTable.id, accessibleAppIds)]
        : []),
    ];

    // PHASE 1 — the whole app roster, newest first. No `limit` and no separate
    // count query: the page is chosen after the cost figures are assembled (see
    // the note on sorting above), so this set is both the sort input and the
    // pagination total.
    const [appRows, baseline] = await Promise.all([
      db
        .select({
          appId: schema.appsTable.id,
          appName: schema.appsTable.name,
          authorName: schema.usersTable.name,
          createdAt: schema.appsTable.createdAt,
          authoringSessionId: schema.appsTable.authoringSessionId,
        })
        .from(schema.appsTable)
        .leftJoin(
          schema.usersTable,
          eq(schema.appsTable.authorId, schema.usersTable.id),
        )
        .where(and(...appFilters))
        .orderBy(desc(schema.appsTable.createdAt)),
      StatisticsModel.getChatCostBaseline({ timeframe, organizationId }),
    ]);
    const total = appRows.length;

    if (total === 0) {
      return {
        ...createPaginatedResult<AppStatistics>([], 0, pagination),
        ...baseline,
      };
    }

    const appIds = appRows.map((row) => row.appId);
    const buildSessionIds = [
      ...new Set(
        appRows
          .map((row) => row.authoringSessionId)
          .filter((id): id is string => !!id),
      ),
    ];

    const [buildBySession, runtimeByApp, usageByApp, appsPerBuildSession] =
      await Promise.all([
        StatisticsModel.getBuildSpendBySession({
          timeframe,
          organizationId,
          sessionIds: buildSessionIds,
        }),
        StatisticsModel.getAppRuntimeSpend({ timeframe, appIds }),
        StatisticsModel.getAppRuntimeUsage({ timeframe, appIds }),
        StatisticsModel.countAppsPerBuildSession({
          organizationId,
          sessionIds: buildSessionIds,
        }),
      ]);

    const assembled: AppStatistics[] = appRows.map((row) => {
      const build = row.authoringSessionId
        ? buildBySession.get(row.authoringSessionId)
        : undefined;
      const runtime = runtimeByApp.get(row.appId);
      const usage = usageByApp.get(row.appId);
      const runs = usage?.runs ?? 0;
      const buildCost = build?.cost ?? 0;
      const runtimeCost = runtime?.cost ?? 0;
      const estimatedChatEquivalentCost =
        runs * baseline.chatBaselineCostPerSession;

      return {
        appId: row.appId,
        appName: row.appName,
        authorName: row.authorName ?? null,
        createdAt: row.createdAt.toISOString(),
        buildRequests: build?.requests ?? 0,
        buildInputTokens: build?.inputTokens ?? 0,
        buildOutputTokens: build?.outputTokens ?? 0,
        buildCost,
        buildSessionAppCount: row.authoringSessionId
          ? (appsPerBuildSession.get(row.authoringSessionId) ?? 1)
          : 0,
        hasBuildSession: !!row.authoringSessionId,
        runtimeLlmRequests: runtime?.requests ?? 0,
        runtimeInputTokens: runtime?.inputTokens ?? 0,
        runtimeOutputTokens: runtime?.outputTokens ?? 0,
        runtimeCost,
        runs,
        toolCalls: usage?.toolCalls ?? 0,
        estimatedChatEquivalentCost,
        estimatedNetSavings:
          estimatedChatEquivalentCost - buildCost - runtimeCost,
      };
    });

    const sorted = sortAppStatistics(assembled, sortBy, sortDirection);
    const page = sorted.slice(
      pagination.offset,
      pagination.offset + pagination.limit,
    );

    return {
      ...createPaginatedResult(page, total, pagination),
      ...baseline,
    };
  }

  /**
   * Per-skill cost. Two figures, because a skill has two honest ones:
   *
   * - `contextTokens` — what the skill's activation blocks added to the context,
   *   measured at injection time and stored on the activation. Entirely the
   *   skill's own, and unrecoverable after the fact: the block lands inside an
   *   ordinary message and `input_tokens` has no per-segment split.
   * - `attributed*` — the spend of the turns that ran with the skill in context:
   *   every interaction in an activation's session at or after the activation.
   *   Shared with whatever else was in those turns, so it is an upper bound on
   *   the skill's influence rather than a bill.
   *
   * Activations are collapsed to one row per (skill, session) on the earliest
   * activation before joining, so a skill activated repeatedly in one session
   * does not count that session's turns once per activation.
   */
  static async getSkillStatistics(params: {
    timeframe: StatisticsTimeFrame;
    organizationId: string;
    pagination: PaginationQuery;
    sortBy: SkillStatisticsSortBy;
    sortDirection: SortDirection;
    /** Skill ids the caller may see; undefined means no scope restriction (admins). */
    accessibleSkillIds?: string[];
  }): Promise<PaginatedResult<SkillStatistics>> {
    const {
      timeframe,
      organizationId,
      pagination,
      sortBy,
      sortDirection,
      accessibleSkillIds,
    } = params;

    if (accessibleSkillIds !== undefined && accessibleSkillIds.length === 0) {
      return createPaginatedResult<SkillStatistics>([], 0, pagination);
    }

    const events = schema.skillUsageEventsTable;
    const eventFilters = [
      eq(schema.skillsTable.organizationId, organizationId),
      notDeleted(schema.skillsTable),
      ...StatisticsModel.timeframeConditions(timeframe, events.createdAt),
      ...(accessibleSkillIds
        ? [inArray(events.skillId, accessibleSkillIds)]
        : []),
    ];

    // PHASE 1 — per-skill activation totals, paginated and sorted in SQL for
    // everything that lives on the event rows themselves.
    const activationsExpr = sql<number>`COUNT(*)`;
    const contextTokensExpr = sql<number>`COALESCE(SUM(${events.contextTokens}), 0)`;
    const lastActivatedExpr = sql`MAX(${events.createdAt})`;

    // Every option here is a real SQL sort over the activation rows, so the page
    // is always the page the caller asked for. Attributed cost is not sortable
    // for that reason — see SKILL_STATISTICS_SORT_BY.
    const sortExpr = {
      contextTokens: contextTokensExpr,
      activations: activationsExpr,
      lastActivatedAt: lastActivatedExpr,
      skillName: sql`${schema.skillsTable.name}`,
    }[sortBy];

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          skillId: events.skillId,
          skillName: schema.skillsTable.name,
          activations: sql<number>`CAST(${activationsExpr} AS INTEGER)`,
          distinctUsers: sql<number>`CAST(COUNT(DISTINCT ${events.userId}) AS INTEGER)`,
          contextTokens: sql<number>`CAST(${contextTokensExpr} AS DOUBLE PRECISION)`,
          measuredActivations: sql<number>`CAST(COUNT(${events.contextTokens}) AS INTEGER)`,
          lastActivatedAt: sql<string>`${lastActivatedExpr}`,
        })
        .from(events)
        .innerJoin(
          schema.skillsTable,
          eq(events.skillId, schema.skillsTable.id),
        )
        .where(and(...eventFilters))
        .groupBy(events.skillId, schema.skillsTable.name)
        .orderBy(sortDirection === "asc" ? asc(sortExpr) : desc(sortExpr))
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({
          total: sql<number>`CAST(COUNT(DISTINCT ${events.skillId}) AS INTEGER)`,
        })
        .from(events)
        .innerJoin(
          schema.skillsTable,
          eq(events.skillId, schema.skillsTable.id),
        )
        .where(and(...eventFilters)),
    ]);

    const pageSkillIds = rows.map((row) => row.skillId);
    const attributed =
      pageSkillIds.length > 0
        ? await StatisticsModel.getSkillAttributedSpend({
            timeframe,
            organizationId,
            skillIds: pageSkillIds,
            eventFilters,
          })
        : new Map<string, SkillAttributedSpend>();

    const data = rows.map((row) => {
      const spend = attributed.get(row.skillId);
      return {
        skillId: row.skillId,
        skillName: row.skillName,
        activations: Number(row.activations) || 0,
        distinctUsers: Number(row.distinctUsers) || 0,
        contextTokens: Number(row.contextTokens) || 0,
        measuredActivations: Number(row.measuredActivations) || 0,
        attributedSessions: spend?.sessions ?? 0,
        attributedRequests: spend?.requests ?? 0,
        attributedInputTokens: spend?.inputTokens ?? 0,
        attributedOutputTokens: spend?.outputTokens ?? 0,
        attributedCost: spend?.cost ?? 0,
        lastActivatedAt: row.lastActivatedAt
          ? new Date(row.lastActivatedAt).toISOString()
          : null,
      };
    });

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
          totalToonSavings: 0,
          totalCacheSavings: 0,
          timeSeries: [],
        };
      }
    }

    const query = db
      .select({
        timeBucket: sql<string>`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
        // All cost/savings figures are billed (metered) only: TOON and cache
        // savings reflect money actually spent. Subscription traffic is
        // reported separately as its would-be list-price cost, never as a
        // saving.
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
          ...StatisticsModel.timeframeConditions(timeframe),
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

    const intervalMinutes = getStatisticsBucketIntervalMinutes(timeframe);

    // Group by custom intervals if needed
    const grouped = new Map<string, CostSavingsRow>();

    for (const row of rawTimeSeriesData) {
      const bucketKey = StatisticsModel.needsRebucketing(
        timeframe,
        intervalMinutes,
      )
        ? StatisticsModel.roundToBucket(row.timeBucket, intervalMinutes)
        : row.timeBucket;

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
    let totalToonSavings = 0;
    let totalCacheSavings = 0;
    let totalSubscriptionCost = 0;

    const timeSeries = timeSeriesData.map((row) => {
      // `row.actualCost` is SUM(interactions.cost) over METERED rows only: the
      // real billed spend. It already reflects every applied saving — TOON's
      // reduced billed token count, the prompt-cache discount, and on
      // historical rows the cheaper model a rule swapped in — so it is the true
      // "Actual Cost". Subscription-fulfilled traffic is excluded here and
      // surfaced separately as `subscriptionCost`.
      const actualCost = Number(row.actualCost);
      // Would-be list-price cost of subscription-covered traffic (not billed).
      const subscriptionCost = Number(row.subscriptionCost);
      // `row.baselineCost` is SUM(interactions.baseline_cost). It only differs
      // from the billed spend on rows written while optimization rules could
      // swap the requested model for a cheaper one; that feature is gone, so
      // new rows record the two as equal and this term is zero for them.
      const baselineModelCost = Number(row.baselineCost);
      const toonSavings = Number(row.toonSavings);
      const cacheSavings = Number(row.cacheSavings);

      // Historical savings from a model swap: identical token usage, requested
      // model vs. the model actually used.
      const modelSwapSavings = baselineModelCost - actualCost;

      // "Non-optimized" cost: what the request would have cost with none of the
      // savings applied (uncompressed tokens, no cache, and — on historical
      // rows — the requested model). Adding each realized saving back onto the
      // real spend keeps this line exactly that far above the actual-cost line,
      // so the savings-breakdown chart reconciles with the gap shown in the
      // non-optimized-vs-actual chart.
      const baselineCost =
        actualCost + modelSwapSavings + toonSavings + cacheSavings;

      totalBaselineCost += baselineCost;
      totalActualCost += actualCost;
      totalToonSavings += toonSavings;
      totalCacheSavings += cacheSavings;
      totalSubscriptionCost += subscriptionCost;

      return {
        timestamp: row.timeBucket,
        baselineCost,
        actualCost,
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
      totalToonSavings,
      totalCacheSavings,
      timeSeries,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Whether the rows coming back from SQL still have to be merged into wider
   * buckets in JS.
   *
   * `getTimeBucket` can only ask `DATE_TRUNC` for a whole calendar unit, so a
   * timeframe whose bucket is a multiple of one — 7d's six hours cut from
   * hourly rows, 90d's three days cut from daily rows, and every sub-hour
   * timeframe, cut from per-minute rows — arrives finer than it should be and
   * is regrouped here. For the rest, the SQL truncation is already the final
   * bucket. Both bucketing paths ask this so they cannot disagree about which
   * rows are already final.
   */
  private static needsRebucketing(
    timeframe: StatisticsTimeFrame,
    intervalMinutes: number,
  ): boolean {
    return intervalMinutes < 60 || timeframe === "7d" || timeframe === "90d";
  }

  /**
   * WHERE conditions restricting a table to a timeframe, covering both the
   * relative presets and `custom:<start>_<end>` ranges. Defaults to
   * `interactions.created_at`; pass another timestamp column to bound a
   * different table (e.g. `skill_usage_events.created_at`) on the same window.
   */
  private static timeframeConditions(
    timeframe: StatisticsTimeFrame,
    column: AnyColumn = schema.interactionsTable.createdAt,
  ): SQL[] {
    const interval = StatisticsModel.getTimeframeInterval(timeframe);

    if (interval) {
      return [gte(column, sql`NOW() - INTERVAL ${sql.raw(`'${interval}'`)}`)];
    }

    const customRange = parseCustomStatisticsTimeframe(timeframe);
    if (!customRange) {
      // Fail closed. `StatisticsTimeFrameSchema` rejects unparseable custom
      // ranges at the API boundary, so this is unreachable from a route — but
      // returning no conditions would drop the date predicate from `and(...)`
      // and silently turn a bounded request into an unbounded scan of whatever
      // table it bounds. An impossible condition is the safe answer.
      return [sql`FALSE`];
    }
    return [
      gte(column, customRange.startTime),
      lte(column, customRange.endTime),
    ];
  }

  /**
   * Restrict interactions to one organization, via the agent that served them.
   *
   * Requires a LEFT JOIN on `agents` at the call site. Deliberately a left join
   * with an IS NULL escape rather than an inner one: `interactions.profile_id` is
   * ON DELETE SET NULL, so an inner join would silently drop every interaction
   * whose agent has since been deleted — which for a build cost means an app
   * quietly reporting less than it cost.
   *
   * The escape has a cost of its own, worth stating: an orphaned row names no
   * organization, so it counts for whichever organization's query its session id
   * matches — potentially more than one. That needs a collision between a
   * conversation uuid and another tenant's authoring session, so it trades a
   * routine, silent undercount (any deleted agent) for a practically
   * unreachable overcount. Removing the trade-off entirely means an
   * `organization_id` snapshot on `interactions`, which is a new column plus a
   * backfill on the platform's largest write-hot table — worth doing if this
   * attribution ever carries billing weight, not for a reporting view.
   */
  private static organizationScopeConditions(organizationId: string): SQL[] {
    return [
      or(
        eq(schema.agentsTable.organizationId, organizationId),
        isNull(schema.interactionsTable.profileId),
      ) as SQL,
    ];
  }

  /**
   * The same organization restriction as {@link organizationScopeConditions},
   * expressed as a subquery on `interactions.profile_id` instead of a join.
   *
   * The join form puts `agents` columns in the WHERE clause, which makes the
   * condition unusable by any query that doesn't also join that table — the
   * shared per-user helpers select from `interactions` alone. This form is a
   * plain predicate on `interactions`, so one WHERE clause can be handed to all
   * of them. It carries the same deliberate `IS NULL` escape for interactions
   * whose agent has been deleted.
   */
  private static organizationScopeSubqueryConditions(
    organizationId: string,
  ): SQL[] {
    return [
      or(
        inArray(
          schema.interactionsTable.profileId,
          db
            .select({ id: schema.agentsTable.id })
            .from(schema.agentsTable)
            .where(eq(schema.agentsTable.organizationId, organizationId)),
        ),
        isNull(schema.interactionsTable.profileId),
      ) as SQL,
    ];
  }

  /**
   * What one chat session costs on average in this timeframe — the measured
   * baseline the per-app savings estimate multiplies.
   *
   * Deliberately measured rather than configured: the alternative is a magic
   * constant nobody can defend, whereas "your own chat sessions averaged $X"
   * is a number a reader can check. Restricted to `source = 'chat'` so it is
   * in-product chat rather than every API caller, and to billed (metered) spend
   * so a subscription-covered org does not get a $0 baseline that makes every
   * app look worthless — it gets a $0 baseline honestly, because that traffic
   * genuinely costs it nothing per token.
   */
  private static async getChatCostBaseline(params: {
    timeframe: StatisticsTimeFrame;
    organizationId: string;
  }): Promise<ChatCostBaseline> {
    const { timeframe, organizationId } = params;
    const perSession = db
      .select({
        sessionCost: billedSum(
          schema.interactionsTable.cost,
          "DOUBLE PRECISION",
        ).as("session_cost"),
      })
      .from(schema.interactionsTable)
      .leftJoin(
        schema.agentsTable,
        eq(schema.interactionsTable.profileId, schema.agentsTable.id),
      )
      .where(
        and(
          ...StatisticsModel.timeframeConditions(timeframe),
          eq(schema.interactionsTable.source, "chat"),
          isNotNull(schema.interactionsTable.sessionId),
          ...StatisticsModel.organizationScopeConditions(organizationId),
        ),
      )
      .groupBy(schema.interactionsTable.sessionId)
      .as("per_session");

    const [row] = await db
      .select({
        sessions: sql<number>`CAST(COUNT(*) AS INTEGER)`,
        averageCost: sql<number>`CAST(COALESCE(AVG(${perSession.sessionCost}), 0) AS DOUBLE PRECISION)`,
      })
      .from(perSession);

    return {
      chatBaselineCostPerSession: Number(row?.averageCost) || 0,
      chatBaselineSessions: Number(row?.sessions) || 0,
    };
  }

  /**
   * Billed spend of each app-authoring session in the timeframe, keyed by
   * session id. Rides `interactions_session_created_at_idx`.
   *
   * A session id is not a tenant-scoped value — an external caller chooses its
   * own via `X-Archestra-Session-Id` — so this is additionally restricted to the
   * organization rather than trusting the id to be unique across tenants.
   */
  private static async getBuildSpendBySession(params: {
    timeframe: StatisticsTimeFrame;
    organizationId: string;
    sessionIds: string[];
  }): Promise<Map<string, InteractionSpend>> {
    const { timeframe, organizationId, sessionIds } = params;
    if (sessionIds.length === 0) return new Map();

    const rows = await db
      .select({
        sessionId: schema.interactionsTable.sessionId,
        requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
        inputTokens: tokenSum(schema.interactionsTable.inputTokens),
        outputTokens: tokenSum(schema.interactionsTable.outputTokens),
        cost: billedSum(schema.interactionsTable.cost, "DOUBLE PRECISION"),
      })
      .from(schema.interactionsTable)
      .leftJoin(
        schema.agentsTable,
        eq(schema.interactionsTable.profileId, schema.agentsTable.id),
      )
      .where(
        and(
          ...StatisticsModel.timeframeConditions(timeframe),
          inArray(schema.interactionsTable.sessionId, sessionIds),
          ...StatisticsModel.organizationScopeConditions(organizationId),
        ),
      )
      .groupBy(schema.interactionsTable.sessionId);

    return new Map(
      rows.flatMap((row) =>
        row.sessionId
          ? [[row.sessionId, toInteractionSpend(row)] as const]
          : [],
      ),
    );
  }

  /**
   * Billed spend of each app's own runtime LLM calls
   * (`archestra.llm.complete()`), keyed by app id.
   */
  private static async getAppRuntimeSpend(params: {
    timeframe: StatisticsTimeFrame;
    appIds: string[];
  }): Promise<Map<string, InteractionSpend>> {
    const { timeframe, appIds } = params;
    if (appIds.length === 0) return new Map();

    const rows = await db
      .select({
        appId: schema.interactionsTable.appId,
        requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
        inputTokens: tokenSum(schema.interactionsTable.inputTokens),
        outputTokens: tokenSum(schema.interactionsTable.outputTokens),
        cost: billedSum(schema.interactionsTable.cost, "DOUBLE PRECISION"),
      })
      .from(schema.interactionsTable)
      .where(
        and(
          ...StatisticsModel.timeframeConditions(timeframe),
          inArray(schema.interactionsTable.appId, appIds),
        ),
      )
      .groupBy(schema.interactionsTable.appId);

    return new Map(
      rows.flatMap((row) =>
        row.appId ? [[row.appId, toInteractionSpend(row)] as const] : [],
      ),
    );
  }

  /**
   * How often each app actually ran, from the app-runtime MCP log (keyed by app
   * and indexed on it).
   *
   * `runs` counts `tools/list` handshakes. The app gateway lists its tools once
   * per host opening the app and declares `listChanged: false`, so there is no
   * re-list to double-count — one row per open. This is the figure the savings
   * estimate multiplies, so it is the one that has to be clean.
   *
   * `toolCalls` counts `tools/call` rows. These include tool previews run from
   * the authoring flow (`preview_app_tool` logs as the app too), so for an app
   * under active development it reads a little high. It is an activity
   * indicator, not an input to any cost figure, and the alternative — filtering
   * on a synthesised tool-call id prefix — would break the first time that
   * prefix changed.
   */
  private static async getAppRuntimeUsage(params: {
    timeframe: StatisticsTimeFrame;
    appIds: string[];
  }): Promise<Map<string, { runs: number; toolCalls: number }>> {
    const { timeframe, appIds } = params;
    if (appIds.length === 0) return new Map();

    const calls = schema.mcpToolCallsTable;
    const rows = await db
      .select({
        appId: calls.appId,
        runs: sql<number>`CAST(COUNT(*) FILTER (WHERE ${calls.method} = 'tools/list') AS INTEGER)`,
        toolCalls: sql<number>`CAST(COUNT(*) FILTER (WHERE ${calls.method} = 'tools/call') AS INTEGER)`,
      })
      .from(calls)
      .where(
        and(
          ...StatisticsModel.timeframeConditions(timeframe, calls.createdAt),
          eq(calls.ownerType, "app"),
          inArray(calls.appId, appIds),
        ),
      )
      .groupBy(calls.appId);

    return new Map(
      rows.flatMap((row) =>
        row.appId
          ? [
              [
                row.appId,
                {
                  runs: Number(row.runs) || 0,
                  toolCalls: Number(row.toolCalls) || 0,
                },
              ] as const,
            ]
          : [],
      ),
    );
  }

  /**
   * How many apps each authoring session produced, so a shared build session is
   * disclosed instead of its spend being reported as one app's alone. Counts
   * across the whole org and all time, not the timeframe: the question is how
   * many apps that session's tokens paid for, which does not change with the
   * window being reported.
   */
  private static async countAppsPerBuildSession(params: {
    organizationId: string;
    sessionIds: string[];
  }): Promise<Map<string, number>> {
    const { organizationId, sessionIds } = params;
    if (sessionIds.length === 0) return new Map();

    const rows = await db
      .select({
        sessionId: schema.appsTable.authoringSessionId,
        count: sql<number>`CAST(COUNT(*) AS INTEGER)`,
      })
      .from(schema.appsTable)
      .where(
        and(
          eq(schema.appsTable.organizationId, organizationId),
          notDeleted(schema.appsTable),
          inArray(schema.appsTable.authoringSessionId, sessionIds),
        ),
      )
      .groupBy(schema.appsTable.authoringSessionId);

    return new Map(
      rows.flatMap((row) =>
        row.sessionId ? [[row.sessionId, Number(row.count) || 0] as const] : [],
      ),
    );
  }

  /**
   * Spend of the turns that ran with each skill in context, keyed by skill id.
   *
   * Activations are first collapsed to one row per (skill, session) on the
   * earliest activation, so a skill activated several times in one session
   * attributes that session's turns once rather than once per activation. The
   * join then takes every interaction of the session from that moment on — the
   * turns whose context actually carried the skill's block; earlier turns in the
   * same session did not, and are excluded.
   *
   * Restricted to the organization for the same reason as the app build spend:
   * `session_id` is caller-chosen, so it is not a tenant boundary on its own.
   */
  private static async getSkillAttributedSpend(params: {
    timeframe: StatisticsTimeFrame;
    organizationId: string;
    skillIds: string[];
    eventFilters: SQL[];
  }): Promise<Map<string, SkillAttributedSpend>> {
    const { timeframe, organizationId, skillIds, eventFilters } = params;
    if (skillIds.length === 0) return new Map();

    const events = schema.skillUsageEventsTable;
    const firstActivations = db
      .select({
        skillId: events.skillId,
        sessionId: events.sessionId,
        firstActivatedAt: sql`MIN(${events.createdAt})`.as(
          "first_activated_at",
        ),
      })
      .from(events)
      .innerJoin(schema.skillsTable, eq(events.skillId, schema.skillsTable.id))
      .where(
        and(
          ...eventFilters,
          inArray(events.skillId, skillIds),
          isNotNull(events.sessionId),
        ),
      )
      .groupBy(events.skillId, events.sessionId)
      .as("first_activations");

    const interactions = schema.interactionsTable;
    const rows = await db
      .select({
        skillId: firstActivations.skillId,
        sessions: sql<number>`CAST(COUNT(DISTINCT ${firstActivations.sessionId}) AS INTEGER)`,
        requests: sql<number>`CAST(COUNT(${interactions.id}) AS INTEGER)`,
        inputTokens: tokenSum(interactions.inputTokens),
        outputTokens: tokenSum(interactions.outputTokens),
        cost: billedSum(interactions.cost, "DOUBLE PRECISION"),
      })
      .from(firstActivations)
      .leftJoin(
        interactions,
        and(
          eq(interactions.sessionId, firstActivations.sessionId),
          gte(interactions.createdAt, firstActivations.firstActivatedAt),
          ...StatisticsModel.timeframeConditions(timeframe),
        ),
      )
      // Same reason as getBuildSpendBySession: the join key is a caller-chosen
      // session id, so it cannot stand alone as a tenant boundary. On the ON
      // clause rather than in a WHERE, so a skill whose sessions have no
      // matching interactions still returns its (zeroed) row.
      .leftJoin(
        schema.agentsTable,
        and(
          eq(interactions.profileId, schema.agentsTable.id),
          eq(schema.agentsTable.organizationId, organizationId),
        ),
      )
      .where(
        or(
          isNull(interactions.id),
          isNotNull(schema.agentsTable.id),
          isNull(interactions.profileId),
        ),
      )
      .groupBy(firstActivations.skillId);

    return new Map(
      rows.map((row) => [
        row.skillId,
        {
          sessions: Number(row.sessions) || 0,
          requests: Number(row.requests) || 0,
          inputTokens: Number(row.inputTokens) || 0,
          outputTokens: Number(row.outputTokens) || 0,
          cost: Number(row.cost) || 0,
        },
      ]),
    );
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
        inputTokens: tokenSum(schema.interactionsTable.inputTokens),
        outputTokens: tokenSum(schema.interactionsTable.outputTokens),
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
        inputTokens: tokenSum(schema.interactionsTable.inputTokens),
        outputTokens: tokenSum(schema.interactionsTable.outputTokens),
        cacheReadTokens: tokenSum(schema.interactionsTable.cacheReadTokens),
        billedCost: billedSum(
          schema.interactionsTable.cost,
          "DOUBLE PRECISION",
        ),
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
        totalTokens:
          (Number(row.inputTokens) || 0) + (Number(row.outputTokens) || 0),
        percentage: 0,
        billedCost: Number(row.billedCost) || 0,
        subscriptionCost: Number(row.subscriptionCost) || 0,
      });
      byUser.set(row.userId, entries);
    }

    for (const entries of byUser.values()) {
      const totalTokens = entries.reduce(
        (sum, entry) => sum + entry.totalTokens,
        0,
      );
      for (const entry of entries) {
        entry.percentage =
          totalTokens > 0 ? (entry.totalTokens / totalTokens) * 100 : 0;
      }
    }
    return byUser;
  }

  /**
   * Report every proxy-attributed row against the organization's single LLM
   * Proxy.
   *
   * An organization has exactly one LLM Proxy. The rows that preceded that
   * consolidation were left in place so their history stays reachable, and
   * `resolveAgent` collapses their ids — and those of legacy dual-purpose
   * `profile` rows — onto the elected proxy for every new request. Reporting
   * follows the same rule, so the proxy's spend is one entity over time
   * rather than a leaderboard of names that no longer resolve to anything a
   * reader can open, configure, or send traffic to.
   *
   * Rows whose organization has no elected proxy (none exists until the
   * organization's first proxy request or the next startup seed) are left
   * untouched rather than dropped: their cost is real either way.
   */
  private static async collapseProxyRows<
    T extends {
      agentId: string;
      agentName: string;
      agentType: string;
      organizationId: string;
      teamName: string | null;
    },
  >(rows: T[]): Promise<T[]> {
    const proxyOrganizationIds = [
      ...new Set(
        rows
          .filter((row) => PROXY_ATTRIBUTED_AGENT_TYPES.has(row.agentType))
          .map((row) => row.organizationId),
      ),
    ];
    if (proxyOrganizationIds.length === 0) {
      return rows;
    }

    const proxies = await AgentModel.findOrgLlmProxies(proxyOrganizationIds);

    return rows.map((row) => {
      if (!PROXY_ATTRIBUTED_AGENT_TYPES.has(row.agentType)) {
        return row;
      }
      const proxy = proxies.get(row.organizationId);
      if (!proxy) {
        return row;
      }
      return {
        ...row,
        agentId: proxy.id,
        agentName: proxy.name,
        agentType: "llm_proxy",
        // The LLM Proxy is an org-scoped singleton and carries no team gating;
        // a donor row's team would misattribute the whole proxy to it.
        teamName: null,
      };
    });
  }
}

/**
 * Agent types whose interactions are LLM Proxy traffic: the proxy itself and
 * the legacy dual-purpose `profile` rows it absorbed. Kept in step with the
 * alias handling in `resolveAgent`.
 */
const PROXY_ATTRIBUTED_AGENT_TYPES: ReadonlySet<string> = new Set([
  "llm_proxy",
  "profile",
]);

// ─── Billing-mode-aware cost aggregates ─────────────────────────────────────
// An interaction's `cost` is the list-price estimate. "Billed spend" is that
// cost only for `metered` rows; `subscription` rows incur no per-token charge
// and contribute 0. The split is expressed as SQL aggregate FILTERs on
// billing_mode. billing_mode is intentionally not in the statistics covering
// index (adding it would require a write-blocking rebuild on a huge table — see
// the interactions schema), so the FILTER reads it from the heap.

/**
 * SUM of an interaction token-count column, returned as a JS number.
 * Cast to DOUBLE PRECISION rather than INTEGER or BIGINT: org-wide token
 * sums exceed int32 ("integer out of range"), and node-postgres returns
 * BIGINT as a string. float8 keeps integer sums exact up to 2^53 tokens.
 */
function tokenSum(column: AnyColumn): SQL<number> {
  return sql<number>`CAST(COALESCE(SUM(${column}), 0) AS DOUBLE PRECISION)`;
}

/** Resolve the executing agent UUID from a direct id or delegation chain. */
function extractUsageClientAgentId(
  externalAgentId: string | null,
): string | null {
  if (!externalAgentId) return null;
  const candidate = externalAgentId.split(":").at(-1);
  return candidate && isUuid(candidate) ? candidate : null;
}

/** Turn stored client attribution into a useful, non-opaque display label. */
function formatUsageClient(
  externalAgentId: string | null,
  agentNames: Map<string, string>,
): string | null {
  if (!externalAgentId) return null;

  const knownClientLabel = clientUsageLabelForExternalAgentId(externalAgentId);
  if (knownClientLabel) return knownClientLabel;

  const agentId = extractUsageClientAgentId(externalAgentId);
  if (agentId) {
    const agentName = agentNames.get(agentId);
    return agentName
      ? `Agent: ${agentName}`
      : `${archestraMcpBranding.appName} agent`;
  }

  return externalAgentId;
}

/**
 * Context bands, ascending. Kept here rather than derived from the Zod enum so
 * the SQL CASE, this order and the schema are edited together — a band added to
 * one and not the others would silently vanish from the response.
 */
const CONTEXT_BUCKET_ORDER: readonly MyContextBucketId[] = [
  "under32k",
  "under128k",
  "under256k",
  "over256k",
];

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

// ─── App / skill cost assembly ──────────────────────────────────────────────

/** Requests, tokens and billed spend of a set of interactions. */
interface InteractionSpend {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/** {@link InteractionSpend} plus the number of sessions it was drawn from. */
interface SkillAttributedSpend extends InteractionSpend {
  sessions: number;
}

/** Coerce one aggregate row's numeric columns (node-postgres returns strings). */
function toInteractionSpend(row: {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}): InteractionSpend {
  return {
    requests: Number(row.requests) || 0,
    inputTokens: Number(row.inputTokens) || 0,
    outputTokens: Number(row.outputTokens) || 0,
    cost: Number(row.cost) || 0,
  };
}

/**
 * Order an assembled app page. Sorting happens here rather than in SQL because
 * the three cost sources live in different tables keyed differently, so no
 * single sortable expression exists without joining all of them for every app in
 * the organization.
 */
function sortAppStatistics(
  apps: AppStatistics[],
  sortBy: AppStatisticsSortBy,
  direction: SortDirection,
): AppStatistics[] {
  const sign = direction === "asc" ? 1 : -1;
  const value = (app: AppStatistics): number => {
    switch (sortBy) {
      case "buildCost":
        return app.buildCost;
      case "runtimeCost":
        return app.runtimeCost;
      case "runs":
        return app.runs;
      case "estimatedNetSavings":
        return app.estimatedNetSavings;
      default:
        return app.buildCost + app.runtimeCost;
    }
  };

  return [...apps].sort((a, b) =>
    sortBy === "appName"
      ? sign * a.appName.localeCompare(b.appName)
      : sign * (value(a) - value(b)),
  );
}

export default StatisticsModel;
