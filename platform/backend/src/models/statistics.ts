import type { StatisticsTimeFrame } from "@shared";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  AgentStatistics,
  CostSavingsStatistics,
  ModelStatistics,
  OverviewStatistics,
  StatisticsTimeSeriesData,
  TeamStatistics,
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
   * Round timestamp to bucket interval
   */
  private static roundToBucket(
    timestamp: string,
    intervalMinutes: number,
  ): string {
    const date = new Date(timestamp);

    if (intervalMinutes >= 1440) {
      // 1 day or more
      const days = Math.floor(intervalMinutes / 1440);
      const dayOfYear = Math.floor(date.getTime() / (1000 * 60 * 60 * 24));
      const roundedDay = Math.floor(dayOfYear / days) * days;

      const startOfYear = new Date(date.getFullYear(), 0, 1);
      startOfYear.setDate(startOfYear.getDate() + roundedDay);
      startOfYear.setHours(0, 0, 0, 0);
      return startOfYear.toISOString();
    } else if (intervalMinutes >= 60) {
      // 1 hour or more
      const hours = Math.floor(intervalMinutes / 60);
      const hourOfDay = date.getHours();
      const roundedHour = Math.floor(hourOfDay / hours) * hours;

      date.setHours(roundedHour, 0, 0, 0);
      return date.toISOString();
    } else {
      // Less than 1 hour
      const minutes = date.getMinutes();
      const roundedMinutes =
        Math.floor(minutes / intervalMinutes) * intervalMinutes;

      date.setMinutes(roundedMinutes, 0, 0);
      return date.toISOString();
    }
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

    // If the interval is standard (60 minutes or more), no custom grouping needed
    if (intervalMinutes >= 60 && timeframe !== "7d" && timeframe !== "90d") {
      return timeSeriesData;
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
        } as T);
      }

      const existing = grouped.get(bucketKey);
      if (!existing) continue;

      existing.requests += Number(row.requests) || 0;
      existing.inputTokens += Number(row.inputTokens) || 0;
      existing.outputTokens += Number(row.outputTokens) || 0;
    }

    return Array.from(grouped.values()).sort(
      (a, b) =>
        new Date(a.timeBucket).getTime() - new Date(b.timeBucket).getTime(),
    );
  }

  /**
   * Get average token prices for cost calculation
   */
  private static async getAverageTokenPrices(): Promise<{
    avgInputPrice: number;
    avgOutputPrice: number;
  }> {
    const result = await db
      .select({
        avgInputPrice: sql<number>`AVG(CAST(${schema.tokenPricesTable.pricePerMillionInput} AS DECIMAL))`,
        avgOutputPrice: sql<number>`AVG(CAST(${schema.tokenPricesTable.pricePerMillionOutput} AS DECIMAL))`,
      })
      .from(schema.tokenPricesTable);

    return {
      avgInputPrice: result[0]?.avgInputPrice || 0,
      avgOutputPrice: result[0]?.avgOutputPrice || 0,
    };
  }

  /**
   * Calculate cost from tokens
   */
  private static calculateCost(
    inputTokens: number,
    outputTokens: number,
    avgInputPrice: number,
    avgOutputPrice: number,
  ): number {
    const inputCost = (inputTokens * avgInputPrice) / 1000000;
    const outputCost = (outputTokens * avgOutputPrice) / 1000000;
    return inputCost + outputCost;
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
    const { avgInputPrice, avgOutputPrice } =
      await StatisticsModel.getAverageTokenPrices();

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
    const query = db
      .select({
        teamId: schema.teamsTable.id,
        teamName: schema.teamsTable.name,
        timeBucket: sql<string>`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
        requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
        inputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.inputTokens}), 0) AS INTEGER)`,
        outputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.outputTokens}), 0) AS INTEGER)`,
      })
      .from(schema.interactionsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.interactionsTable.profileId, schema.agentsTable.id),
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

    // Debug logging for 1h timeframe only
    if (timeframe === "1h") {
    }

    const timeSeriesData = StatisticsModel.groupTimeSeries(
      rawTimeSeriesData,
      timeframe,
      "teamId",
    );

    if (timeframe === "1h") {
    }

    // Get team member counts
    const teamMemberCounts = await db
      .select({
        teamId: schema.teamsTable.id,
        memberCount: sql<number>`CAST(COUNT(DISTINCT ${schema.membersTable.userId}) AS INTEGER)`,
      })
      .from(schema.teamsTable)
      .leftJoin(
        schema.membersTable,
        eq(
          schema.teamsTable.organizationId,
          schema.membersTable.organizationId,
        ),
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
      const cost = StatisticsModel.calculateCost(
        Number(row.inputTokens),
        Number(row.outputTokens),
        avgInputPrice,
        avgOutputPrice,
      );

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
    const { avgInputPrice, avgOutputPrice } =
      await StatisticsModel.getAverageTokenPrices();

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

    const query = db
      .select({
        agentId: schema.agentsTable.id,
        agentName: schema.agentsTable.name,
        teamName: schema.teamsTable.name,
        timeBucket: sql<string>`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
        requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
        inputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.inputTokens}), 0) AS INTEGER)`,
        outputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.outputTokens}), 0) AS INTEGER)`,
      })
      .from(schema.interactionsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.interactionsTable.profileId, schema.agentsTable.id),
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
        schema.teamsTable.name,
        sql`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
      )
      .orderBy(
        sql`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
      );

    const rawTimeSeriesData = await query;

    // Debug logging for 1h timeframe only
    if (timeframe === "1h") {
    }

    const timeSeriesData = StatisticsModel.groupTimeSeries(
      rawTimeSeriesData,
      timeframe,
      "agentId",
    );

    if (timeframe === "1h") {
    }

    // Aggregate data by agent
    const agentMap = new Map<string, AgentStatistics>();

    for (const row of timeSeriesData) {
      const cost = StatisticsModel.calculateCost(
        Number(row.inputTokens),
        Number(row.outputTokens),
        avgInputPrice,
        avgOutputPrice,
      );

      if (!agentMap.has(row.agentId)) {
        agentMap.set(row.agentId, {
          agentId: row.agentId,
          agentName: row.agentName,
          teamName: row.teamName || "No Team",
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          timeSeries: [],
        });
      }

      const agent = agentMap.get(row.agentId);
      if (!agent) continue;
      agent.requests += Number(row.requests);
      agent.inputTokens += Number(row.inputTokens);
      agent.outputTokens += Number(row.outputTokens);
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
    const { avgInputPrice, avgOutputPrice } =
      await StatisticsModel.getAverageTokenPrices();

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

    const query = db
      .select({
        model: schema.interactionsTable.model,
        timeBucket: sql<string>`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
        requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
        inputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.inputTokens}), 0) AS INTEGER)`,
        outputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.outputTokens}), 0) AS INTEGER)`,
      })
      .from(schema.interactionsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.interactionsTable.profileId, schema.agentsTable.id),
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

      const cost = StatisticsModel.calculateCost(
        Number(row.inputTokens),
        Number(row.outputTokens),
        avgInputPrice,
        avgOutputPrice,
      );

      totalCost += cost;

      if (!modelMap.has(row.model)) {
        modelMap.set(row.model, {
          model: row.model,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
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
   * Calculate actual cost: cost - toon_savings
   * This represents the final cost after all optimizations
   * - cost = cost after model optimization
   * - toonSavings = savings from TOON compression
   * - actual cost = cost after both model optimization and TOON
   */
  private static calculateActualCost(
    cost: number,
    toonSavings: number,
  ): number {
    return cost - toonSavings;
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
          totalOptimizationSavings: 0,
          totalToonSavings: 0,
          timeSeries: [],
        };
      }
    }

    const query = db
      .select({
        timeBucket: sql<string>`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
        baselineCost: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.baselineCost}), 0) AS DECIMAL)`,
        actualCost: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.cost}), 0) AS DECIMAL)`,
        toonSavings: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.toonCostSavings}), 0) AS DECIMAL)`,
      })
      .from(schema.interactionsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.interactionsTable.profileId, schema.agentsTable.id),
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
        });
      }

      const existing = grouped.get(bucketKey);
      if (!existing) continue;

      existing.baselineCost += Number(row.baselineCost);
      existing.actualCost += Number(row.actualCost);
      existing.toonSavings += Number(row.toonSavings);
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

    const timeSeries = timeSeriesData.map((row) => {
      const baselineCost = Number(row.baselineCost);
      const cost = Number(row.actualCost);
      const toonSavings = Number(row.toonSavings);

      const actualCost = StatisticsModel.calculateActualCost(cost, toonSavings);
      const optimizationSavings = baselineCost - cost;

      totalBaselineCost += baselineCost;
      totalActualCost += actualCost;
      totalOptimizationSavings += optimizationSavings;
      totalToonSavings += toonSavings;

      return {
        timestamp: row.timeBucket,
        baselineCost,
        actualCost,
        optimizationSavings,
        toonSavings,
      };
    });

    const totalSavings = totalBaselineCost - totalActualCost;

    return {
      totalBaselineCost,
      totalActualCost,
      totalSavings,
      totalOptimizationSavings,
      totalToonSavings,
      timeSeries,
    };
  }
}

export default StatisticsModel;
