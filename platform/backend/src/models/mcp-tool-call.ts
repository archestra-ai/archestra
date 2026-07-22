import type { PaginationQuery } from "@archestra/shared";
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
  max,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type { InsertMcpToolCall, McpToolCall, SortingQuery } from "@/types";
import { escapeLikePattern } from "@/utils/sql-search";
import AgentTeamModel from "./agent-team";

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
          agentDeletedAt: schema.agentsTable.deletedAt,
          appName: schema.appsTable.name,
          appDeletedAt: schema.appsTable.deletedAt,
        })
        .from(schema.mcpToolCallsTable)
        .leftJoin(
          schema.usersTable,
          eq(schema.mcpToolCallsTable.userId, schema.usersTable.id),
        )
        .leftJoin(
          schema.agentsTable,
          eq(schema.mcpToolCallsTable.agentId, schema.agentsTable.id),
        )
        .leftJoin(
          schema.appsTable,
          eq(schema.mcpToolCallsTable.appId, schema.appsTable.id),
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
      data.map(toVisibleMcpToolCall),
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
        agentDeletedAt: schema.agentsTable.deletedAt,
        appName: schema.appsTable.name,
        appDeletedAt: schema.appsTable.deletedAt,
      })
      .from(schema.mcpToolCallsTable)
      .leftJoin(
        schema.usersTable,
        eq(schema.mcpToolCallsTable.userId, schema.usersTable.id),
      )
      .leftJoin(
        schema.agentsTable,
        eq(schema.mcpToolCallsTable.agentId, schema.agentsTable.id),
      )
      .leftJoin(
        schema.appsTable,
        eq(schema.mcpToolCallsTable.appId, schema.appsTable.id),
      )
      .where(eq(schema.mcpToolCallsTable.id, id));

    if (!mcpToolCall) {
      return null;
    }

    // Check access control for non-MCP server admins
    if (userId && !isMcpServerAdmin) {
      // If agentId is null (agent was deleted), only admins can see the tool call
      if (!mcpToolCall.agentId) {
        return null;
      }
      const hasAccess = await AgentTeamModel.userHasAgentAccess(
        userId,
        mcpToolCall.agentId,
        false,
      );
      if (!hasAccess) {
        return null;
      }
    }

    return toVisibleMcpToolCall(mcpToolCall);
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
          // Agent-scoped rows are never app-owned; select the column anyway so
          // rows satisfy the McpToolCall contract (appName is non-optional).
          appName: sql<string | null>`null`,
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

  /**
   * Batch-load the timestamp of the most recent MCP call (any method) per
   * agent. Agents with no recorded calls are absent from the returned map.
   */
  static async getLastCallAtForAgents(
    agentIds: string[],
  ): Promise<Map<string, Date>> {
    if (agentIds.length === 0) return new Map();

    const rows = await db
      .select({
        agentId: schema.mcpToolCallsTable.agentId,
        lastCallAt: max(schema.mcpToolCallsTable.createdAt),
      })
      .from(schema.mcpToolCallsTable)
      .where(inArray(schema.mcpToolCallsTable.agentId, agentIds))
      .groupBy(schema.mcpToolCallsTable.agentId);

    const lastCallMap = new Map<string, Date>();
    for (const row of rows) {
      if (row.agentId && row.lastCallAt) {
        lastCallMap.set(row.agentId, row.lastCallAt);
      }
    }
    return lastCallMap;
  }

  /**
   * When the first successful tools/call was routed (a recorded result
   * without `isError`); null when none yet. An activation signal for the
   * feedback pop-up.
   */
  static async getFirstSuccessfulToolCallAt(): Promise<Date | null> {
    const [row] = await db
      .select({ createdAt: schema.mcpToolCallsTable.createdAt })
      .from(schema.mcpToolCallsTable)
      .where(
        and(
          eq(schema.mcpToolCallsTable.method, "tools/call"),
          sql`${schema.mcpToolCallsTable.toolResult} IS NOT NULL`,
          sql`(${schema.mcpToolCallsTable.toolResult} ->> 'isError') IS DISTINCT FROM 'true'`,
        ),
      )
      .orderBy(asc(schema.mcpToolCallsTable.createdAt))
      .limit(1);
    return row?.createdAt ?? null;
  }
}

export default McpToolCallModel;

function toVisibleMcpToolCall(
  row: McpToolCall & {
    agentDeletedAt?: Date | null;
    appDeletedAt?: Date | null;
  },
): McpToolCall {
  const {
    agentDeletedAt: _agentDeletedAt,
    appDeletedAt: _appDeletedAt,
    ...toolCall
  } = row;

  return {
    ...toolCall,
    // Null out references to soft-deleted owners so consumers can't resolve
    // them; ownerType still tells which kind of owner made the call.
    agentId: row.agentDeletedAt ? null : toolCall.agentId,
    appId: row.appDeletedAt ? null : toolCall.appId,
    appName: row.appDeletedAt ? null : toolCall.appName,
  };
}
