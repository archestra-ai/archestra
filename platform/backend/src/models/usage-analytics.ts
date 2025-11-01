import { and, count, eq, gte, inArray, sql, sum } from "drizzle-orm";
import db, { schema } from "@/database";
import type { UsageBreakdown, UsagePeriod } from "@/types";
import AgentTeamModel from "./agent-team";

class UsageAnalyticsModel {
  /**
   * Get date filter based on period
   */
  private static getDateFilter(period: UsagePeriod) {
    const now = new Date();
    let startDate: Date;

    switch (period) {
      case "daily":
        startDate = new Date(now);
        startDate.setHours(0, 0, 0, 0);
        break;
      case "weekly":
        startDate = new Date(now);
        startDate.setDate(now.getDate() - 7);
        startDate.setHours(0, 0, 0, 0);
        break;
      case "monthly":
        startDate = new Date(now);
        startDate.setMonth(now.getMonth() - 1);
        startDate.setHours(0, 0, 0, 0);
        break;
      default:
        startDate = new Date(now);
        startDate.setHours(0, 0, 0, 0);
    }

    return gte(schema.interactionsTable.createdAt, startDate);
  }

  /**
   * Calculate cost for tokens
   */
  private static calculateCost(
    inputTokens: number | null,
    outputTokens: number | null,
    inputPricePer1M: string | null,
    outputPricePer1M: string | null,
  ): number {
    // Use default prices if not configured (50.00 per 1M tokens as per token_pricing table defaults)
    const defaultPrice = 50.0;
    const inputPrice = inputPricePer1M
      ? Number(inputPricePer1M)
      : inputTokens
        ? defaultPrice
        : 0;
    const outputPrice = outputPricePer1M
      ? Number(outputPricePer1M)
      : outputTokens
        ? defaultPrice
        : 0;

    const input = ((inputTokens || 0) * inputPrice) / 1_000_000;
    const output = ((outputTokens || 0) * outputPrice) / 1_000_000;
    return input + output;
  }

  /**
   * Get cost breakdown by teams
   */
  static async getCostBreakdownByTeams(
    period: UsagePeriod,
    userId?: string,
    isAdmin?: boolean,
  ): Promise<UsageBreakdown[]> {
    const dateFilter = UsageAnalyticsModel.getDateFilter(period);

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
        teamId: schema.agentTeamTable.teamId,
        teamName: schema.team.name,
        totalInputTokens: sum(schema.interactionsTable.inputTokens),
        totalOutputTokens: sum(schema.interactionsTable.outputTokens),
        totalCalls: count(schema.interactionsTable.id),
        avgInputPrice: sql<string>`AVG(${schema.tokenPricingTable.inputPricePer1M})`,
        avgOutputPrice: sql<string>`AVG(${schema.tokenPricingTable.outputPricePer1M})`,
      })
      .from(schema.interactionsTable)
      .innerJoin(
        schema.agentTeamTable,
        eq(schema.interactionsTable.agentId, schema.agentTeamTable.agentId),
      )
      .innerJoin(schema.team, eq(schema.agentTeamTable.teamId, schema.team.id))
      .leftJoin(
        schema.tokenPricingTable,
        and(
          eq(
            schema.interactionsTable.provider,
            schema.tokenPricingTable.provider,
          ),
          eq(schema.interactionsTable.model, schema.tokenPricingTable.model),
        ),
      )
      .where(
        and(
          dateFilter,
          userId && !isAdmin
            ? inArray(schema.interactionsTable.agentId, accessibleAgentIds)
            : undefined,
        ),
      )
      .groupBy(schema.agentTeamTable.teamId, schema.team.name);

    const results = await query;

    const totalCost = results.reduce((acc, row) => {
      const cost = UsageAnalyticsModel.calculateCost(
        Number(row.totalInputTokens),
        Number(row.totalOutputTokens),
        row.avgInputPrice,
        row.avgOutputPrice,
      );
      return acc + cost;
    }, 0);

    const breakdowns = results.map((row) => {
      const cost = UsageAnalyticsModel.calculateCost(
        Number(row.totalInputTokens),
        Number(row.totalOutputTokens),
        row.avgInputPrice,
        row.avgOutputPrice,
      );

      return {
        id: row.teamId,
        name: row.teamName || "Unknown Team",
        cost,
        percentage: totalCost > 0 ? (cost / totalCost) * 100 : 0,
        calls: Number(row.totalCalls),
        tokens:
          Number(row.totalInputTokens || 0) +
          Number(row.totalOutputTokens || 0),
      };
    });

    // Sort by cost descending (highest usage first)
    // If costs are equal, sort by tokens as a fallback
    return breakdowns.sort((a, b) => {
      if (b.cost !== a.cost) {
        return b.cost - a.cost;
      }
      return (b.tokens || 0) - (a.tokens || 0);
    });
  }

  /**
   * Get cost breakdown by agents
   */
  static async getCostBreakdownByAgents(
    period: UsagePeriod,
    userId?: string,
    isAdmin?: boolean,
  ): Promise<UsageBreakdown[]> {
    const dateFilter = UsageAnalyticsModel.getDateFilter(period);

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
        agentId: schema.interactionsTable.agentId,
        agentName: schema.agentsTable.name,
        totalInputTokens: sum(schema.interactionsTable.inputTokens),
        totalOutputTokens: sum(schema.interactionsTable.outputTokens),
        totalCalls: count(schema.interactionsTable.id),
        avgInputPrice: sql<string>`AVG(${schema.tokenPricingTable.inputPricePer1M})`,
        avgOutputPrice: sql<string>`AVG(${schema.tokenPricingTable.outputPricePer1M})`,
      })
      .from(schema.interactionsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.interactionsTable.agentId, schema.agentsTable.id),
      )
      .leftJoin(
        schema.tokenPricingTable,
        and(
          eq(
            schema.interactionsTable.provider,
            schema.tokenPricingTable.provider,
          ),
          eq(schema.interactionsTable.model, schema.tokenPricingTable.model),
        ),
      )
      .where(
        and(
          dateFilter,
          userId && !isAdmin
            ? inArray(schema.interactionsTable.agentId, accessibleAgentIds)
            : undefined,
        ),
      )
      .groupBy(schema.interactionsTable.agentId, schema.agentsTable.name);

    const results = await query;

    const totalCost = results.reduce((acc, row) => {
      const cost = UsageAnalyticsModel.calculateCost(
        Number(row.totalInputTokens),
        Number(row.totalOutputTokens),
        row.avgInputPrice,
        row.avgOutputPrice,
      );
      return acc + cost;
    }, 0);

    const breakdowns = results.map((row) => {
      const cost = UsageAnalyticsModel.calculateCost(
        Number(row.totalInputTokens),
        Number(row.totalOutputTokens),
        row.avgInputPrice,
        row.avgOutputPrice,
      );

      return {
        id: row.agentId,
        name: row.agentName,
        cost,
        percentage: totalCost > 0 ? (cost / totalCost) * 100 : 0,
        calls: Number(row.totalCalls),
        tokens:
          Number(row.totalInputTokens || 0) +
          Number(row.totalOutputTokens || 0),
      };
    });

    // Sort by cost descending (highest usage first)
    // If costs are equal, sort by tokens as a fallback
    return breakdowns.sort((a, b) => {
      if (b.cost !== a.cost) {
        return b.cost - a.cost;
      }
      return (b.tokens || 0) - (a.tokens || 0);
    });
  }

  /**
   * Get cost breakdown by providers
   */
  static async getCostBreakdownByProviders(
    period: UsagePeriod,
    userId?: string,
    isAdmin?: boolean,
  ): Promise<UsageBreakdown[]> {
    const dateFilter = UsageAnalyticsModel.getDateFilter(period);

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
        provider: schema.interactionsTable.provider,
        totalInputTokens: sum(schema.interactionsTable.inputTokens),
        totalOutputTokens: sum(schema.interactionsTable.outputTokens),
        totalCalls: count(schema.interactionsTable.id),
        avgInputPrice: sql<string>`AVG(${schema.tokenPricingTable.inputPricePer1M})`,
        avgOutputPrice: sql<string>`AVG(${schema.tokenPricingTable.outputPricePer1M})`,
      })
      .from(schema.interactionsTable)
      .leftJoin(
        schema.tokenPricingTable,
        and(
          eq(
            schema.interactionsTable.provider,
            schema.tokenPricingTable.provider,
          ),
          eq(schema.interactionsTable.model, schema.tokenPricingTable.model),
        ),
      )
      .where(
        and(
          dateFilter,
          userId && !isAdmin
            ? inArray(schema.interactionsTable.agentId, accessibleAgentIds)
            : undefined,
        ),
      )
      .groupBy(schema.interactionsTable.provider);

    const results = await query;

    const totalCost = results.reduce((acc, row) => {
      const cost = UsageAnalyticsModel.calculateCost(
        Number(row.totalInputTokens),
        Number(row.totalOutputTokens),
        row.avgInputPrice,
        row.avgOutputPrice,
      );
      return acc + cost;
    }, 0);

    const breakdowns = results.map((row) => {
      const cost = UsageAnalyticsModel.calculateCost(
        Number(row.totalInputTokens),
        Number(row.totalOutputTokens),
        row.avgInputPrice,
        row.avgOutputPrice,
      );

      return {
        id: row.provider || "unknown",
        name: row.provider || "Unknown Provider",
        cost,
        percentage: totalCost > 0 ? (cost / totalCost) * 100 : 0,
        calls: Number(row.totalCalls),
        tokens:
          Number(row.totalInputTokens || 0) +
          Number(row.totalOutputTokens || 0),
      };
    });

    // Sort by cost descending (highest usage first)
    // If costs are equal, sort by tokens as a fallback
    return breakdowns.sort((a, b) => {
      if (b.cost !== a.cost) {
        return b.cost - a.cost;
      }
      return (b.tokens || 0) - (a.tokens || 0);
    });
  }

  /**
   * Get cost breakdown by models
   */
  static async getCostBreakdownByModels(
    period: UsagePeriod,
    userId?: string,
    isAdmin?: boolean,
  ): Promise<UsageBreakdown[]> {
    const dateFilter = UsageAnalyticsModel.getDateFilter(period);

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
        provider: schema.interactionsTable.provider,
        totalInputTokens: sum(schema.interactionsTable.inputTokens),
        totalOutputTokens: sum(schema.interactionsTable.outputTokens),
        totalCalls: count(schema.interactionsTable.id),
        avgInputPrice: sql<string>`MAX(${schema.tokenPricingTable.inputPricePer1M})`,
        avgOutputPrice: sql<string>`MAX(${schema.tokenPricingTable.outputPricePer1M})`,
      })
      .from(schema.interactionsTable)
      .leftJoin(
        schema.tokenPricingTable,
        and(
          eq(
            schema.interactionsTable.provider,
            schema.tokenPricingTable.provider,
          ),
          eq(schema.interactionsTable.model, schema.tokenPricingTable.model),
        ),
      )
      .where(
        and(
          dateFilter,
          userId && !isAdmin
            ? inArray(schema.interactionsTable.agentId, accessibleAgentIds)
            : undefined,
        ),
      )
      .groupBy(
        schema.interactionsTable.model,
        schema.interactionsTable.provider,
      );

    const results = await query;

    const totalCost = results.reduce((acc, row) => {
      const cost = UsageAnalyticsModel.calculateCost(
        Number(row.totalInputTokens),
        Number(row.totalOutputTokens),
        row.avgInputPrice,
        row.avgOutputPrice,
      );
      return acc + cost;
    }, 0);

    const breakdowns = results.map((row) => {
      const cost = UsageAnalyticsModel.calculateCost(
        Number(row.totalInputTokens),
        Number(row.totalOutputTokens),
        row.avgInputPrice,
        row.avgOutputPrice,
      );

      return {
        id: `${row.provider}-${row.model}`,
        name: row.model || "Unknown Model",
        cost,
        percentage: totalCost > 0 ? (cost / totalCost) * 100 : 0,
        calls: Number(row.totalCalls),
        tokens:
          Number(row.totalInputTokens || 0) +
          Number(row.totalOutputTokens || 0),
      };
    });

    // Sort by cost descending (highest usage first)
    // If costs are equal, sort by tokens as a fallback
    return breakdowns.sort((a, b) => {
      if (b.cost !== a.cost) {
        return b.cost - a.cost;
      }
      return (b.tokens || 0) - (a.tokens || 0);
    });
  }

  /**
   * Get current spend for a period
   */
  static async getCurrentSpend(
    period: UsagePeriod,
    userId?: string,
    isAdmin?: boolean,
  ): Promise<number> {
    const dateFilter = UsageAnalyticsModel.getDateFilter(period);

    let accessibleAgentIds: string[] = [];
    if (userId && !isAdmin) {
      accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        false,
      );
      if (accessibleAgentIds.length === 0) {
        return 0;
      }
    }

    const query = db
      .select({
        model: schema.interactionsTable.model,
        provider: schema.interactionsTable.provider,
        totalInputTokens: sum(schema.interactionsTable.inputTokens),
        totalOutputTokens: sum(schema.interactionsTable.outputTokens),
        inputPrice: schema.tokenPricingTable.inputPricePer1M,
        outputPrice: schema.tokenPricingTable.outputPricePer1M,
      })
      .from(schema.interactionsTable)
      .leftJoin(
        schema.tokenPricingTable,
        and(
          eq(
            schema.interactionsTable.provider,
            schema.tokenPricingTable.provider,
          ),
          eq(schema.interactionsTable.model, schema.tokenPricingTable.model),
        ),
      )
      .where(
        and(
          dateFilter,
          userId && !isAdmin
            ? inArray(schema.interactionsTable.agentId, accessibleAgentIds)
            : undefined,
        ),
      )
      .groupBy(
        schema.interactionsTable.model,
        schema.interactionsTable.provider,
        schema.tokenPricingTable.inputPricePer1M,
        schema.tokenPricingTable.outputPricePer1M,
      );

    const results = await query;

    return results.reduce((acc, row) => {
      const cost = UsageAnalyticsModel.calculateCost(
        Number(row.totalInputTokens),
        Number(row.totalOutputTokens),
        row.inputPrice,
        row.outputPrice,
      );
      return acc + cost;
    }, 0);
  }
}

export default UsageAnalyticsModel;
