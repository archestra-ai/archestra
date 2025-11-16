import { and, asc, count, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import logger from "@/logging";
import type {
  InsertInteraction,
  Interaction,
  PaginationQuery,
  SortingQuery,
} from "@/types";
import AgentTeamModel from "./agent-team";
import LimitModel from "./limit";

class InteractionModel {
  static async create(data: InsertInteraction) {
    const [interaction] = await db
      .insert(schema.interactionsTable)
      .values(data)
      .returning();

    // Update usage tracking after interaction is created
    // Run in background to not block the response
    InteractionModel.updateUsageAfterInteraction(
      interaction as InsertInteraction & { id: string },
    ).catch((error) => {
      logger.error(
        { error },
        `Failed to update usage tracking for interaction ${interaction.id}`,
      );
    });

    return interaction;
  }

  /**
   * Find all interactions with pagination and sorting support
   */
  static async findAllPaginated(
    pagination: PaginationQuery,
    sorting?: SortingQuery,
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<PaginatedResult<Interaction>> {
    // Determine the ORDER BY clause based on sorting params
    const orderByClause = InteractionModel.getOrderByClause(sorting);

    // Build where clause for access control
    let whereClause: SQL | undefined;
    if (userId && !isAgentAdmin) {
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return createPaginatedResult([], 0, pagination);
      }

      whereClause = inArray(
        schema.interactionsTable.agentId,
        accessibleAgentIds,
      );
    }

    const [data, [{ total }]] = await Promise.all([
      db
        .select()
        .from(schema.interactionsTable)
        .where(whereClause)
        .orderBy(orderByClause)
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ total: count() })
        .from(schema.interactionsTable)
        .where(whereClause),
    ]);

    return createPaginatedResult(
      data as Interaction[],
      Number(total),
      pagination,
    );
  }

  /**
   * Helper to get the appropriate ORDER BY clause based on sorting params
   */
  private static getOrderByClause(sorting?: SortingQuery) {
    const direction = sorting?.sortDirection === "asc" ? asc : desc;

    switch (sorting?.sortBy) {
      case "createdAt":
        return direction(schema.interactionsTable.createdAt);
      case "agentId":
        return direction(schema.interactionsTable.agentId);
      case "model":
        // Extract model from the JSONB request column
        // Wrap in parentheses to ensure correct precedence for the JSON operator
        return direction(
          sql`(${schema.interactionsTable.request} ->> 'model')`,
        );
      default:
        // Default: newest first
        return desc(schema.interactionsTable.createdAt);
    }
  }

  static async findById(
    id: string,
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<Interaction | null> {
    const [interaction] = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, id));

    if (!interaction) {
      return null;
    }

    // Check access control for non-agent admins
    if (userId && !isAgentAdmin) {
      const hasAccess = await AgentTeamModel.userHasAgentAccess(
        userId,
        interaction.agentId,
        false,
      );
      if (!hasAccess) {
        return null;
      }
    }

    return interaction as Interaction;
  }

  static async getAllInteractionsForAgent(
    agentId: string,
    whereClauses?: SQL[],
  ) {
    return db
      .select()
      .from(schema.interactionsTable)
      .where(
        and(
          eq(schema.interactionsTable.agentId, agentId),
          ...(whereClauses ?? []),
        ),
      )
      .orderBy(asc(schema.interactionsTable.createdAt));
  }

  /**
   * Get all interactions for an agent with pagination and sorting support
   */
  static async getAllInteractionsForAgentPaginated(
    agentId: string,
    pagination: PaginationQuery,
    sorting?: SortingQuery,
    whereClauses?: SQL[],
  ): Promise<PaginatedResult<Interaction>> {
    const whereCondition = and(
      eq(schema.interactionsTable.agentId, agentId),
      ...(whereClauses ?? []),
    );

    const orderByClause = InteractionModel.getOrderByClause(sorting);

    const [data, [{ total }]] = await Promise.all([
      db
        .select()
        .from(schema.interactionsTable)
        .where(whereCondition)
        .orderBy(orderByClause)
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ total: count() })
        .from(schema.interactionsTable)
        .where(whereCondition),
    ]);

    return createPaginatedResult(
      data as Interaction[],
      Number(total),
      pagination,
    );
  }

  static async getCount() {
    const [result] = await db
      .select({ total: count() })
      .from(schema.interactionsTable);
    return result.total;
  }

  /**
   * Update usage limits after an interaction is created
   */
  static async updateUsageAfterInteraction(
    interaction: InsertInteraction & { id: string },
  ): Promise<void> {
    try {
      // Calculate token usage for this interaction
      const inputTokens = interaction.inputTokens || 0;
      const outputTokens = interaction.outputTokens || 0;

      if (inputTokens === 0 && outputTokens === 0) {
        // No tokens used, nothing to update
        return;
      }

      // Get agent's teams to update team and organization limits
      const agentTeamIds = await AgentTeamModel.getTeamsForAgent(
        interaction.agentId,
      );

      const updatePromises: Promise<void>[] = [];

      if (agentTeamIds.length === 0) {
        logger.warn(
          `Agent ${interaction.agentId} has no team assignments for interaction ${interaction.id}`,
        );

        // Even if agent has no teams, we should still try to update organization limits
        // We'll use a default organization approach - get the first organization from existing limits
        try {
          const existingOrgLimits = await db
            .select({ entityId: schema.limitsTable.entityId })
            .from(schema.limitsTable)
            .where(eq(schema.limitsTable.entityType, "organization"))
            .limit(1);

          if (existingOrgLimits.length > 0) {
            updatePromises.push(
              LimitModel.updateTokenLimitUsage(
                "organization",
                existingOrgLimits[0].entityId,
                inputTokens,
                outputTokens,
              ),
            );
          }
        } catch (error) {
          logger.error(
            { error },
            "Failed to find organization for agent with no teams",
          );
        }
      } else {
        // Get team details to access organizationId
        const teams = await db
          .select()
          .from(schema.teamsTable)
          .where(inArray(schema.teamsTable.id, agentTeamIds));

        // Update organization-level token cost limits (from first team's organization)
        if (teams.length > 0 && teams[0].organizationId) {
          updatePromises.push(
            LimitModel.updateTokenLimitUsage(
              "organization",
              teams[0].organizationId,
              inputTokens,
              outputTokens,
            ),
          );
        }

        // Update team-level token cost limits
        for (const team of teams) {
          updatePromises.push(
            LimitModel.updateTokenLimitUsage(
              "team",
              team.id,
              inputTokens,
              outputTokens,
            ),
          );
        }
      }

      // Update agent-level token cost limits (if any exist)
      updatePromises.push(
        LimitModel.updateTokenLimitUsage(
          "agent",
          interaction.agentId,
          inputTokens,
          outputTokens,
        ),
      );

      // Execute all updates in parallel
      await Promise.all(updatePromises);
    } catch (error) {
      logger.error({ error }, "Error updating usage limits after interaction");
      // Don't throw - usage tracking should not break interaction creation
    }
  }
}

export default InteractionModel;
