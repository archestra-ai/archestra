import {
  type PaginationQuery,
  redactCatalogToolArguments,
} from "@archestra/shared";
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
  isNull,
  lte,
  max,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import {
  decryptMcpToolCallContent,
  encryptMcpToolCallContent,
  readMcpToolCallRow,
} from "@/content-encryption/audit-rows";
import {
  isContentDecryptionAvailable,
  isContentEncryptionEnabled,
  // biome-ignore lint/style/noRestrictedImports: dual-licensed; no-ops when the feature is off
} from "@/content-encryption/index.ee";
import type { LockedChatAuditContext } from "@/content-encryption/locked-chat";
import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type { InsertMcpToolCall, McpToolCall, SortingQuery } from "@/types";
import { escapeLikePattern } from "@/utils/sql-search";
import AgentTeamModel from "./agent-team";

/**
 * Builds a search condition for MCP tool calls across server name, method,
 * tool name, arguments, and result. Under content encryption the tool_call
 * and tool_result columns store ciphertext, so search degrades to the
 * metadata columns (server name + method) — same pattern as conversation
 * search degrading to titles.
 */
function buildMcpToolCallSearchCondition(search: string) {
  const searchPattern = `%${escapeLikePattern(search)}%`;
  const searchContent = !isContentEncryptionEnabled();
  return or(
    ilike(schema.mcpToolCallsTable.mcpServerName, searchPattern),
    ilike(schema.mcpToolCallsTable.method, searchPattern),
    ilike(schema.mcpToolCallsTable.executionId, searchPattern),
    ...(searchContent
      ? [
          sql`${schema.mcpToolCallsTable.toolCall}->>'name' ILIKE ${searchPattern}`,
          sql`(${schema.mcpToolCallsTable.toolCall}->'arguments')::text ILIKE ${searchPattern}`,
          sql`${schema.mcpToolCallsTable.toolResult}::text ILIKE ${searchPattern}`,
        ]
      : []),
  );
}

class McpToolCallModel {
  /**
   * @param auditContext when present, this tool call belongs to a locked-chat
   * conversation: `toolCall`/`toolResult` are encrypted under that
   * conversation's browser-held key and the row is stamped with the
   * discriminator, instead of the server key (or plaintext).
   */
  static async create(
    data: InsertMcpToolCall,
    auditContext?: LockedChatAuditContext | null,
  ) {
    const audit = auditContext ?? null;
    const [mcpToolCall] = await db
      .insert(schema.mcpToolCallsTable)
      // Spread first: the encrypt helper mutates in place, and callers must
      // keep their plaintext copy (e.g. to build the JSON-RPC response).
      .values(
        encryptMcpToolCallContent(redactToolCallArguments({ ...data }), audit),
      )
      .returning();

    // Decrypting on a write path is only safe because the key came from this
    // caller. A read path that might meet a row keyed to a conversation it
    // cannot open must go through the locked-row guards instead.
    return decryptMcpToolCallContent(mcpToolCall, audit);
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
      /** Narrow to rows attributed to this user (the own-logs log:read view). */
      ownUserId?: string;
    },
  ): Promise<PaginatedResult<McpToolCall>> {
    // Determine the ORDER BY clause based on sorting params
    const orderByClause = McpToolCallModel.getOrderByClause(sorting);

    // Build where clauses
    const conditions: SQL[] = [];
    if (filters?.ownUserId) {
      conditions.push(eq(schema.mcpToolCallsTable.userId, filters.ownUserId));
    }

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
      data.map((row) => toVisibleMcpToolCall(readMcpToolCallRow(row))),
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

    return toVisibleMcpToolCall(readMcpToolCallRow(mcpToolCall));
  }

  static async getAllMcpToolCallsForAgent(
    agentId: string,
    whereClauses?: SQL[],
  ) {
    const rows = await db
      .select()
      .from(schema.mcpToolCallsTable)
      .where(
        and(
          eq(schema.mcpToolCallsTable.agentId, agentId),
          ...(whereClauses ?? []),
        ),
      )
      .orderBy(asc(schema.mcpToolCallsTable.createdAt));
    return rows.map(readMcpToolCallRow);
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
      /** Narrow to rows attributed to this user (the own-logs log:read view). */
      ownUserId?: string;
    },
  ): Promise<PaginatedResult<McpToolCall>> {
    // Build conditions array
    const conditions: SQL[] = [eq(schema.mcpToolCallsTable.agentId, agentId)];
    if (filters?.ownUserId) {
      conditions.push(eq(schema.mcpToolCallsTable.userId, filters.ownUserId));
    }

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
      data.map(readMcpToolCallRow) as McpToolCall[],
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

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * Enterprise data-retention sweep: delete tool-call rows older than the
   * retention window in bounded batches. Batches stay small because the GIN
   * trigram indexes (method, server name, and — outside content encryption,
   * which drops it — tool_result) make bulk deletes substantially more
   * expensive than the row count suggests. SQL-side cutoff for the same
   * timestamp-without-time-zone reason as the interactions sweep.
   */
  static async deleteExpired(params: {
    retentionDays: number;
    batchSize?: number;
    maxBatches?: number;
  }): Promise<number> {
    const batchSize = params.batchSize ?? 500;
    const maxBatches = params.maxBatches ?? 1000;
    let totalDeleted = 0;

    for (let batch = 0; batch < maxBatches; batch++) {
      const result = await db.execute<{ deleted: number }>(sql`
        WITH fence AS (
          SELECT id
          FROM ${schema.mcpToolCallsTable}
          WHERE created_at < now()::timestamp - make_interval(days => ${params.retentionDays})
          LIMIT ${batchSize}
        ),
        removed AS (
          DELETE FROM ${schema.mcpToolCallsTable}
          WHERE id IN (SELECT id FROM fence)
          RETURNING 1
        )
        SELECT COUNT(*)::int AS deleted FROM removed
      `);
      const deleted = Number(result.rows[0]?.deleted ?? 0);
      totalDeleted += deleted;
      if (deleted < batchSize) break;
    }

    return totalDeleted;
  }
  // SPDX-SnippetEnd

  /**
   * App-level variant of the first-success scan for encrypted deployments:
   * keyset-walk tools/call rows oldest-first, decrypt each result, return
   * the first without `isError: true`. Cursor uses the driver's raw
   * `created_at` text so the timestamp-without-time-zone value round-trips
   * exactly (same reasoning as the content backfill's interactions cursor).
   */
  private static async findFirstSuccessfulToolCallAtDecrypting(): Promise<Date | null> {
    const batchSize = 200;
    let cursor: { createdAt: string; id: string } | null = null;

    while (true) {
      const cursorClause: SQL = cursor
        ? sql`AND (created_at, id) > (${cursor.createdAt}::timestamp, ${cursor.id}::uuid)`
        : sql``;
      const page = await db.execute<{
        id: string;
        created_at_text: string;
        tool_result: unknown;
      }>(sql`
        SELECT id, created_at::text AS created_at_text, tool_result
        FROM ${schema.mcpToolCallsTable}
        WHERE method = 'tools/call' AND tool_result IS NOT NULL
          -- LockedChat rows are keyed to a browser this process cannot reach,
          -- so their result is unreadable here. Excluded in SQL rather than
          -- skipped in JS: the locked sentinel has no top-level isError, so
          -- an encrypted FAILURE would otherwise be counted as the first
          -- success and mis-fire onboarding.
          AND locked_chat_conversation_id IS NULL
        ${cursorClause}
        ORDER BY created_at ASC, id ASC
        LIMIT ${batchSize}
      `);

      for (const row of page.rows) {
        const result = readMcpToolCallRow(row).tool_result;
        const isError =
          typeof result === "object" &&
          result !== null &&
          (result as { isError?: unknown }).isError === true;
        if (!isError) {
          // Re-read through drizzle so the Date carries the same
          // timestamp-without-time-zone interpretation as every other model
          // read (the raw driver would parse the bare text as local time).
          const [hit] = await db
            .select({ createdAt: schema.mcpToolCallsTable.createdAt })
            .from(schema.mcpToolCallsTable)
            .where(eq(schema.mcpToolCallsTable.id, row.id));
          return hit?.createdAt ?? null;
        }
      }

      const last = page.rows.at(-1);
      if (!last || page.rows.length < batchSize) return null;
      cursor = { createdAt: last.created_at_text, id: last.id };
    }
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
   *
   * Under content encryption `tool_result` may be a ciphertext envelope the
   * SQL `->> 'isError'` predicate cannot see into (it would read every
   * encrypted error as a success), so when decryption is in play the rows
   * are walked oldest-first and checked after decryption. Successful calls
   * dominate real tables, so the walk exits on the first batch in practice.
   */
  static async getFirstSuccessfulToolCallAt(): Promise<Date | null> {
    if (isContentDecryptionAvailable()) {
      return McpToolCallModel.findFirstSuccessfulToolCallAtDecrypting();
    }

    const [row] = await db
      .select({ createdAt: schema.mcpToolCallsTable.createdAt })
      .from(schema.mcpToolCallsTable)
      .where(
        and(
          eq(schema.mcpToolCallsTable.method, "tools/call"),
          sql`${schema.mcpToolCallsTable.toolResult} IS NOT NULL`,
          // Same exclusion as the decrypting branch, and it matters MORE here:
          // this path runs when at-rest encryption is off, where locked-chat
          // rows still exist, and it reads `isError` straight out of JSON. A
          // DEK envelope has no such key, so an encrypted failure would read
          // as a success.
          isNull(schema.mcpToolCallsTable.lockedChatConversationId),
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

/**
 * Strips credential values out of the logged arguments. Reassigns `toolCall`
 * rather than editing it, so the caller's plaintext copy — which the gateway
 * still needs for its JSON-RPC response — is left intact.
 */
function redactToolCallArguments(values: InsertMcpToolCall): InsertMcpToolCall {
  const toolCall = values.toolCall;
  if (!toolCall?.arguments) return values;

  const redacted = redactCatalogToolArguments(toolCall.arguments);
  // Same reference back means nothing matched; skip the rewrite entirely.
  if (redacted === toolCall.arguments) return values;

  values.toolCall = { ...toolCall, arguments: redacted };
  return values;
}
