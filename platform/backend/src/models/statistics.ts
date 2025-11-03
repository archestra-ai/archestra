import { and, eq, gte, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import AgentTeamModel from "./agent-team";

export type TimeFrame = "1h" | "24h" | "7d" | "30d" | "90d" | "12m" | "all";

export interface TimeSeriesPoint {
  timestamp: string;
  value: number;
}

export interface TeamStatistics {
  teamId: string;
  teamName: string;
  members: number;
  agents: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  timeSeries: TimeSeriesPoint[];
}

export interface AgentStatistics {
  agentId: string;
  agentName: string;
  teamName: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  timeSeries: TimeSeriesPoint[];
}

export interface ModelStatistics {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  percentage: number;
  timeSeries: TimeSeriesPoint[];
}

export interface OverviewStatistics {
  totalRequests: number;
  totalTokens: number;
  totalCost: number;
  topTeam: string;
  topAgent: string;
  topModel: string;
}

// Base time series interface
export interface BaseTimeSeriesData {
  timeBucket: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

// Team-specific time series data
export interface TeamTimeSeriesData extends BaseTimeSeriesData {
  teamId: string;
  teamName: string;
}

// Agent-specific time series data
export interface AgentTimeSeriesData extends BaseTimeSeriesData {
  agentId: string;
  agentName: string;
  teamName: string | null;
}

// Model-specific time series data
export interface ModelTimeSeriesData extends BaseTimeSeriesData {
  model: string | null;
}

// Union type for all time series data
export type TimeSeriesData =
  | BaseTimeSeriesData
  | TeamTimeSeriesData
  | AgentTimeSeriesData
  | ModelTimeSeriesData;

class StatisticsModel {
  /**
   * Convert timeframe to SQL interval
   */
  private static getTimeframeInterval(timeframe: TimeFrame): string {
    switch (timeframe) {
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
  private static getTimeBucket(timeframe: TimeFrame): string {
    switch (timeframe) {
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
  private static getBucketIntervalMinutes(timeframe: TimeFrame): number {
    switch (timeframe) {
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
   * Group time series data by custom bucket intervals
   */
  private static groupTimeSeries<T extends BaseTimeSeriesData>(
    timeSeriesData: T[],
    timeframe: TimeFrame,
  ): T[] {
    const intervalMinutes = StatisticsModel.getBucketIntervalMinutes(timeframe);

    // If the interval is standard (60 minutes or more), no custom grouping needed
    if (intervalMinutes >= 60 && timeframe !== "7d" && timeframe !== "90d") {
      return timeSeriesData;
    }

    // Group by custom intervals
    const grouped = new Map<string, T>();

    for (const row of timeSeriesData) {
      const bucketKey = StatisticsModel.roundToBucket(
        row.timeBucket,
        intervalMinutes,
      );

      if (!grouped.has(bucketKey)) {
        grouped.set(bucketKey, {
          ...row,
          timeBucket: bucketKey,
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
        avgInputPrice: sql<number>`AVG(CAST(${schema.tokenPriceTable.pricePerMillionInput} AS DECIMAL))`,
        avgOutputPrice: sql<number>`AVG(CAST(${schema.tokenPriceTable.pricePerMillionOutput} AS DECIMAL))`,
      })
      .from(schema.tokenPriceTable);

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
    timeframe: TimeFrame,
    userId?: string,
    isAdmin?: boolean,
  ): Promise<TeamStatistics[]> {
    const interval = StatisticsModel.getTimeframeInterval(timeframe);
    const timeBucket = StatisticsModel.getTimeBucket(timeframe);
    const { avgInputPrice, avgOutputPrice } =
      await StatisticsModel.getAverageTokenPrices();

    // Get accessible agent IDs for non-admin users
    let accessibleAgentIds: string[] = [];
    if (userId && !isAdmin) {
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
        teamId: schema.team.id,
        teamName: schema.team.name,
        timeBucket: sql<string>`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
        requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
        inputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.inputTokens}), 0) AS INTEGER)`,
        outputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.outputTokens}), 0) AS INTEGER)`,
      })
      .from(schema.interactionsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.interactionsTable.agentId, schema.agentsTable.id),
      )
      .innerJoin(
        schema.agentTeamTable,
        eq(schema.agentsTable.id, schema.agentTeamTable.agentId),
      )
      .innerJoin(schema.team, eq(schema.agentTeamTable.teamId, schema.team.id))
      .where(
        and(
          gte(
            schema.interactionsTable.createdAt,
            sql`NOW() - INTERVAL ${sql.raw(`'${interval}'`)}`,
          ),
          ...(accessibleAgentIds.length > 0
            ? [inArray(schema.agentsTable.id, accessibleAgentIds)]
            : []),
        ),
      )
      .groupBy(
        schema.team.id,
        schema.team.name,
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
    );

    if (timeframe === "1h") {
    }

    // Get team member counts
    const teamMemberCounts = await db
      .select({
        teamId: schema.team.id,
        memberCount: sql<number>`CAST(COUNT(DISTINCT ${schema.member.userId}) AS INTEGER)`,
      })
      .from(schema.team)
      .leftJoin(
        schema.member,
        eq(schema.team.organizationId, schema.member.organizationId),
      )
      .groupBy(schema.team.id);

    // Get agent counts per team
    const teamAgentCounts = await db
      .select({
        teamId: schema.team.id,
        agentCount: sql<number>`CAST(COUNT(DISTINCT ${schema.agentTeamTable.agentId}) AS INTEGER)`,
      })
      .from(schema.team)
      .leftJoin(
        schema.agentTeamTable,
        eq(schema.team.id, schema.agentTeamTable.teamId),
      )
      .groupBy(schema.team.id);

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
    timeframe: TimeFrame,
    userId?: string,
    isAdmin?: boolean,
  ): Promise<AgentStatistics[]> {
    const interval = StatisticsModel.getTimeframeInterval(timeframe);
    const timeBucket = StatisticsModel.getTimeBucket(timeframe);
    const { avgInputPrice, avgOutputPrice } =
      await StatisticsModel.getAverageTokenPrices();

    // Get accessible agent IDs for non-admin users
    let accessibleAgentIds: string[] = [];
    if (userId && !isAdmin) {
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
        teamName: schema.team.name,
        timeBucket: sql<string>`DATE_TRUNC(${sql.raw(`'${timeBucket}'`)}, ${schema.interactionsTable.createdAt})`,
        requests: sql<number>`CAST(COUNT(*) AS INTEGER)`,
        inputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.inputTokens}), 0) AS INTEGER)`,
        outputTokens: sql<number>`CAST(COALESCE(SUM(${schema.interactionsTable.outputTokens}), 0) AS INTEGER)`,
      })
      .from(schema.interactionsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.interactionsTable.agentId, schema.agentsTable.id),
      )
      .leftJoin(
        schema.agentTeamTable,
        eq(schema.agentsTable.id, schema.agentTeamTable.agentId),
      )
      .leftJoin(schema.team, eq(schema.agentTeamTable.teamId, schema.team.id))
      .where(
        and(
          gte(
            schema.interactionsTable.createdAt,
            sql`NOW() - INTERVAL ${sql.raw(`'${interval}'`)}`,
          ),
          ...(accessibleAgentIds.length > 0
            ? [inArray(schema.agentsTable.id, accessibleAgentIds)]
            : []),
        ),
      )
      .groupBy(
        schema.agentsTable.id,
        schema.agentsTable.name,
        schema.team.name,
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
    timeframe: TimeFrame,
    userId?: string,
    isAdmin?: boolean,
  ): Promise<ModelStatistics[]> {
    const interval = StatisticsModel.getTimeframeInterval(timeframe);
    const timeBucket = StatisticsModel.getTimeBucket(timeframe);
    const { avgInputPrice, avgOutputPrice } =
      await StatisticsModel.getAverageTokenPrices();

    // Get accessible agent IDs for non-admin users
    let accessibleAgentIds: string[] = [];
    if (userId && !isAdmin) {
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
        eq(schema.interactionsTable.agentId, schema.agentsTable.id),
      )
      .where(
        and(
          gte(
            schema.interactionsTable.createdAt,
            sql`NOW() - INTERVAL ${sql.raw(`'${interval}'`)}`,
          ),
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
    timeframe: TimeFrame,
    userId?: string,
    isAdmin?: boolean,
  ): Promise<OverviewStatistics> {
    const [teamStats, agentStats, modelStats] = await Promise.all([
      StatisticsModel.getTeamStatistics(timeframe, userId, isAdmin),
      StatisticsModel.getAgentStatistics(timeframe, userId, isAdmin),
      StatisticsModel.getModelStatistics(timeframe, userId, isAdmin),
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
      teamStats.reduce((top, team) =>
        team.cost > (top?.cost || 0) ? team : top,
      )?.teamName || "";

    const topAgent =
      agentStats.reduce((top, agent) =>
        agent.cost > (top?.cost || 0) ? agent : top,
      )?.agentName || "";

    const topModel =
      modelStats.reduce((top, model) =>
        model.cost > (top?.cost || 0) ? model : top,
      )?.model || "";

    return {
      totalRequests,
      totalTokens,
      totalCost,
      topTeam,
      topAgent,
      topModel,
    };
  }
}

export default StatisticsModel;
