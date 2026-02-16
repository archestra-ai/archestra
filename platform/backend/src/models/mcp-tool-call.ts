import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
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

/**
 * Escapes special LIKE pattern characters (%, _, \) to treat them as literals.
 * This prevents users from crafting searches that behave unexpectedly.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

/**
 * Builds a search condition for MCP tool calls across server name, method, tool name, arguments, and result.
 */
function buildMcpToolCallSearchCondition(search: string) {
  const searchPattern = `%${escapeLikePattern(search)}%`;
  return or(
    ilike(schema.mcpToolCallsTable.mcpServerName, searchPattern),
    ilike(schema.mcpToolCallsTable.method, searchPattern),
    sql`${schema.mcpToolCallsTable.toolCall}->>'name' ILIKE ${searchPattern}`,
    sql`(${schema.mcpToolCallsTable.toolCall}->'arguments')::text ILIKE ${searchPattern}`,
    sql`${schema.mcpToolCallsTable.toolResult}::text ILIKE ${searchPattern}`,
  );
}

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
    filters?: {
      startDate?: Date;
      endDate?: Date;
      search?: string;
    },
  ): Promise<PaginatedResult<McpToolCall>> {
    // Determine the ORDER BY clause based on sorting params
    const orderByClause = McpToolCallModel.getOrderByClause(sorting);

    // Build where clauses
    const conditions: SQL[] = [];

    // Access control filter
    if (userId && !isMcpServerAdmin) {
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return createPaginatedResult([], 0, pagination);
      }

      conditions.push(
        inArray(schema.mcpToolCallsTable.agentId, accessibleAgentIds),
      );
    }

    // Date range filter
    if (filters?.startDate) {
      conditions.push(
        gte(schema.mcpToolCallsTable.createdAt, filters.startDate),
      );
    }
    if (filters?.endDate) {
      conditions.push(lte(schema.mcpToolCallsTable.createdAt, filters.endDate));
    }

    // Free-text search filter (case-insensitive)
    // Searches across: mcpServerName, toolCall.name, toolCall.arguments
    if (filters?.search) {
      const searchCondition = buildMcpToolCallSearchCondition(filters.search);
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [data, [{ total }]] = await Promise.all([
      db
        .select({
          ...getTableColumns(schema.mcpToolCallsTable),
          userName: schema.usersTable.name,
        })
        .from(schema.mcpToolCallsTable)
        .leftJoin(
          schema.usersTable,
          eq(schema.mcpToolCallsTable.userId, schema.usersTable.id),
        )
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
      .select({
        ...getTableColumns(schema.mcpToolCallsTable),
        userName: schema.usersTable.name,
      })
      .from(schema.mcpToolCallsTable)
      .leftJoin(
        schema.usersTable,
        eq(schema.mcpToolCallsTable.userId, schema.usersTable.id),
      )
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
    filters?: {
      startDate?: Date;
      endDate?: Date;
      search?: string;
    },
  ): Promise<PaginatedResult<McpToolCall>> {
    // Build conditions array
    const conditions: SQL[] = [eq(schema.mcpToolCallsTable.agentId, agentId)];

    // Add any custom where clauses
    if (whereClauses && whereClauses.length > 0) {
      conditions.push(...whereClauses);
    }

    // Date range filter
    if (filters?.startDate) {
      conditions.push(
        gte(schema.mcpToolCallsTable.createdAt, filters.startDate),
      );
    }
    if (filters?.endDate) {
      conditions.push(lte(schema.mcpToolCallsTable.createdAt, filters.endDate));
    }

    // Free-text search filter (case-insensitive)
    // Searches across: mcpServerName, toolCall.name, toolCall.arguments
    if (filters?.search) {
      const searchCondition = buildMcpToolCallSearchCondition(filters.search);
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    const whereCondition = and(...conditions);

    const orderByClause = McpToolCallModel.getOrderByClause(sorting);

    const [data, [{ total }]] = await Promise.all([
      db
        .select({
          ...getTableColumns(schema.mcpToolCallsTable),
          userName: schema.usersTable.name,
        })
        .from(schema.mcpToolCallsTable)
        .leftJoin(
          schema.usersTable,
          eq(schema.mcpToolCallsTable.userId, schema.usersTable.id),
        )
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

  static async getCount() {
    const [result] = await db
      .select({ total: count() })
      .from(schema.mcpToolCallsTable);
    return result.total;
  }
}

export default McpToolCallModel;
