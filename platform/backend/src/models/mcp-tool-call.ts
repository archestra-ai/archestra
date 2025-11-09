import { and, asc, count, desc, eq, inArray, type SQL } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type {
  InsertMcpToolCall,
  McpToolCall,
  PaginationQuery,
  SortingQuery,
} from "@/types";
import AgentTeamModel from "./agent-team";

class McpToolCallModel {
  static async create(data: InsertMcpToolCall) {
    const [mcpToolCall] = await db
      .insert(schema.mcpToolCallsTable)
      .values(data)
      .returning();

    return mcpToolCall;
  }

  /**
   * Find all MCP tool calls with pagination and sorting support
   */
  static async findAllPaginated(
    pagination: PaginationQuery,
    sorting?: SortingQuery,
    userId?: string,
    isMcpServerAdmin?: boolean,
  ): Promise<PaginatedResult<McpToolCall>> {
    // Determine the ORDER BY clause based on sorting params
    const orderByClause = McpToolCallModel.getOrderByClause(sorting);

    // Build where clause for access control
    let whereClause: SQL | undefined;
    if (userId && !isMcpServerAdmin) {
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return createPaginatedResult([], 0, pagination);
      }

      whereClause = inArray(
        schema.mcpToolCallsTable.agentId,
        accessibleAgentIds,
      );
    }

    const [data, [{ total }]] = await Promise.all([
      db
        .select()
        .from(schema.mcpToolCallsTable)
        .where(whereClause)
        .orderBy(orderByClause)
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ total: count() })
        .from(schema.mcpToolCallsTable)
        .where(whereClause),
    ]);

    return createPaginatedResult(
      data as McpToolCall[],
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
        return direction(schema.mcpToolCallsTable.createdAt);
      case "agentId":
        return direction(schema.mcpToolCallsTable.agentId);
      case "mcpServerName":
        return direction(schema.mcpToolCallsTable.mcpServerName);
      case "method":
        return direction(schema.mcpToolCallsTable.method);
      default:
        // Default: newest first
        return desc(schema.mcpToolCallsTable.createdAt);
    }
  }

  static async findById(
    id: string,
    userId?: string,
    isMcpServerAdmin?: boolean,
  ): Promise<McpToolCall | null> {
    const [mcpToolCall] = await db
      .select()
      .from(schema.mcpToolCallsTable)
      .where(eq(schema.mcpToolCallsTable.id, id));

    if (!mcpToolCall) {
      return null;
    }

    // Check access control for non-MCP server admins
    if (userId && !isMcpServerAdmin) {
      const hasAccess = await AgentTeamModel.userHasAgentAccess(
        userId,
        mcpToolCall.agentId,
        false,
      );
      if (!hasAccess) {
        return null;
      }
    }

    return mcpToolCall;
  }

  static async getAllMcpToolCallsForAgent(
    agentId: string,
    whereClauses?: SQL[],
  ) {
    return db
      .select()
      .from(schema.mcpToolCallsTable)
      .where(
        and(
          eq(schema.mcpToolCallsTable.agentId, agentId),
          ...(whereClauses ?? []),
        ),
      )
      .orderBy(asc(schema.mcpToolCallsTable.createdAt));
  }

  /**
   * Get all MCP tool calls for an agent with pagination and sorting support
   */
  static async getAllMcpToolCallsForAgentPaginated(
    agentId: string,
    pagination: PaginationQuery,
    sorting?: SortingQuery,
    whereClauses?: SQL[],
  ): Promise<PaginatedResult<McpToolCall>> {
    const whereCondition = and(
      eq(schema.mcpToolCallsTable.agentId, agentId),
      ...(whereClauses ?? []),
    );

    const orderByClause = McpToolCallModel.getOrderByClause(sorting);

    const [data, [{ total }]] = await Promise.all([
      db
        .select()
        .from(schema.mcpToolCallsTable)
        .where(whereCondition)
        .orderBy(orderByClause)
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ total: count() })
        .from(schema.mcpToolCallsTable)
        .where(whereCondition),
    ]);

    return createPaginatedResult(
      data as McpToolCall[],
      Number(total),
      pagination,
    );
  }
}

export default McpToolCallModel;
