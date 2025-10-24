import { and, asc, count, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type {
  InsertInteraction,
  Interaction,
  PaginationQuery,
  SortingQuery,
} from "@/types";
import AgentAccessControlModel from "./agent-access-control";

class InteractionModel {
  static async create(data: InsertInteraction) {
    const [interaction] = await db
      .insert(schema.interactionsTable)
      .values(data)
      .returning();

    return interaction;
  }

  static async findAll(
    userId?: string,
    isAdmin?: boolean,
  ): Promise<Interaction[]> {
    let query = db
      .select()
      .from(schema.interactionsTable)
      .orderBy(desc(schema.interactionsTable.createdAt))
      .$dynamic();

    // Apply access control filtering for non-admins
    if (userId && !isAdmin) {
      const accessibleAgentIds =
        await AgentAccessControlModel.getUserAccessibleAgentIds(userId);

      if (accessibleAgentIds.length === 0) {
        return [];
      }

      query = query.where(
        inArray(schema.interactionsTable.agentId, accessibleAgentIds),
      );
    }

    const rows = await query;
    return rows as Interaction[];
  }

  /**
   * Find all interactions with pagination and sorting support
   */
  static async findAllPaginated(
    pagination: PaginationQuery,
    sorting?: SortingQuery,
    userId?: string,
    isAdmin?: boolean,
  ): Promise<PaginatedResult<Interaction>> {
    // Determine the ORDER BY clause based on sorting params
    const orderByClause = InteractionModel.getOrderByClause(sorting);

    // Build where clause for access control
    let whereClause: SQL | undefined;
    if (userId && !isAdmin) {
      const accessibleAgentIds =
        await AgentAccessControlModel.getUserAccessibleAgentIds(userId);

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
    isAdmin?: boolean,
  ): Promise<Interaction | null> {
    const [interaction] = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, id));

    if (!interaction) {
      return null;
    }

    // Check access control for non-admins
    if (userId && !isAdmin) {
      const hasAccess = await AgentAccessControlModel.userHasAgentAccess(
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

  /**
   * Get past tool responses for a specific tool and agent
   * Returns the most recent tool responses (up to limit)
   */
  static async getPastToolResponses(
    agentId: string,
    toolName: string,
    limit = 10,
  ): Promise<Array<{ content: unknown; timestamp: Date }>> {
    const interactions = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.agentId, agentId))
      .orderBy(desc(schema.interactionsTable.createdAt))
      .limit(limit * 10); // Get more interactions to filter through

    const toolResponses: Array<{ content: unknown; timestamp: Date }> = [];

    // Parse interactions and extract tool responses matching the tool name
    for (const interaction of interactions) {
      if (toolResponses.length >= limit) break;

      const response = interaction.response as Record<string, unknown>;

      // Handle different LLM provider response formats
      if (interaction.type === "openai:chatCompletions") {
        const choices = response.choices as Array<{
          message?: { tool_calls?: Array<{ function?: { name?: string } }> };
        }>;
        if (choices?.[0]?.message?.tool_calls) {
          for (const toolCall of choices[0].message.tool_calls) {
            if (toolCall.function?.name === toolName) {
              // Find the corresponding tool result in the request
              const request = interaction.request as Record<string, unknown>;
              const messages = request.messages as Array<{
                role?: string;
                tool_call_id?: string;
                content?: unknown;
              }>;
              if (messages) {
                const toolResult = messages.find(
                  (m) => m.role === "tool" && m.tool_call_id === toolCall,
                );
                if (toolResult) {
                  toolResponses.push({
                    content: toolResult.content,
                    timestamp: interaction.createdAt,
                  });
                }
              }
            }
          }
        }
      } else if (interaction.type === "anthropic:messages") {
        const content = response.content as Array<{
          type?: string;
          name?: string;
          input?: unknown;
        }>;
        if (content) {
          for (const block of content) {
            if (block.type === "tool_use" && block.name === toolName) {
              // Find the corresponding tool result in the request
              const request = interaction.request as Record<string, unknown>;
              const messages = request.messages as Array<{
                content?:
                  | Array<{
                      type?: string;
                      tool_use_id?: string;
                      content?: unknown;
                    }>
                  | unknown;
              }>;
              if (messages) {
                for (const msg of messages) {
                  if (Array.isArray(msg.content)) {
                    const toolResult = msg.content.find(
                      (c) =>
                        c.type === "tool_result" && c.tool_use_id === block,
                    );
                    if (toolResult) {
                      toolResponses.push({
                        content: toolResult.content,
                        timestamp: interaction.createdAt,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    return toolResponses;
  }
}

export default InteractionModel;
