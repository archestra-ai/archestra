import {
  calculatePaginationMeta,
  type PaginationQuery,
  type StatisticsTimeFrame,
} from "@archestra/shared";
import {
  type AnyColumn,
  and,
  asc,
  desc,
  eq,
  inArray,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type {
  AppUsageDimension,
  AppUsageResponse,
  McpToolCallUsageDimension,
  McpToolCallUsageResponse,
  SkillUsageDimension,
  SkillUsageResponse,
} from "@/types";
import { mcpToolCallBelongsToOrganization } from "./log-organization";
import { MCP_TOOL_CALL_TOOL_NAME as TOOL_NAME } from "./mcp-tool-call-name";
import StatisticsModel from "./statistics";

/**
 * Grouped usage reporting: one row per distinct combination of the requested
 * dimensions, paginated and ordered in SQL. Grouping by `day` (a UTC calendar
 * day) makes any breakdown a daily series, so callers such as dashboards can
 * pull per-day, per-person, per-tool numbers without one endpoint per shape.
 */
class UsageStatisticsModel {
  /**
   * MCP `tools/call` usage, from the tool-call log. Covers calls made by agents,
   * gateways and apps.
   */
  static async getMcpToolCallUsage(
    params: UsageScope & {
      groupBy: McpToolCallUsageDimension[];
      agentId?: string;
      appId?: string;
      mcpServerName?: string;
      toolName?: string;
    },
  ): Promise<McpToolCallUsageResponse> {
    const calls = schema.mcpToolCallsTable;
    const { groupBy, pagination } = params;

    const dimensionColumns: Record<
      McpToolCallUsageDimension,
      Record<string, SQL | PgColumn>
    > = {
      day: { day: utcDay(calls.createdAt) },
      mcpServerName: { mcpServerName: calls.mcpServerName },
      toolName: { toolName: TOOL_NAME },
      userId: { userId: calls.userId, userName: schema.usersTable.name },
      agentId: { agentId: calls.agentId, agentName: schema.agentsTable.name },
      appId: { appId: calls.appId, appName: schema.appsTable.name },
    };
    const selected = selectDimensions(dimensionColumns, groupBy);

    const where = and(
      mcpToolCallBelongsToOrganization(params.organizationId),
      eq(calls.method, "tools/call"),
      ...StatisticsModel.timeframeConditions(params.timeframe, calls.createdAt),
      ...userScopeConditions(calls.userId, params),
      ...(params.agentId ? [eq(calls.agentId, params.agentId)] : []),
      ...(params.appId ? [eq(calls.appId, params.appId)] : []),
      ...(params.mcpServerName
        ? [eq(calls.mcpServerName, params.mcpServerName)]
        : []),
      ...(params.toolName ? [sql`${TOOL_NAME} = ${params.toolName}`] : []),
    );

    const callCount = sql<number>`CAST(COUNT(*) AS INTEGER)`;
    const errorCount = sql<number>`CAST(COUNT(*) FILTER (WHERE ${IS_ERROR}) AS INTEGER)`;

    const groupedQuery = db
      .select({
        ...selected,
        calls: callCount,
        errors: errorCount,
        total: TOTAL_GROUPS,
      })
      .from(calls)
      .leftJoin(schema.usersTable, eq(schema.usersTable.id, calls.userId))
      .leftJoin(schema.agentsTable, eq(schema.agentsTable.id, calls.agentId))
      .leftJoin(schema.appsTable, eq(schema.appsTable.id, calls.appId))
      .where(where)
      .groupBy(...Object.values(selected));
    const [rows, [totals]] = await Promise.all([
      groupedQuery
        .orderBy(...usageOrder(selected, callCount))
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ calls: callCount, errors: errorCount })
        .from(calls)
        .where(where),
    ]);

    return {
      ...paginate(
        rows,
        pagination,
        (row) => ({
          ...row,
          calls: Number(row.calls),
          errors: Number(row.errors),
        }),
        await emptyPageTotal(rows, pagination, () =>
          groupedQuery.limit(1).offset(0),
        ),
      ),
      totals: {
        calls: Number(totals?.calls ?? 0),
        errors: Number(totals?.errors ?? 0),
      },
    };
  }

  /**
   * App usage: how often each app was opened and the tool calls it made (from
   * the tool-call log), plus the LLM requests it made and their spend (from
   * interactions attributed to the app). Apps outside `accessibleAppIds` are
   * excluded.
   */
  static async getAppUsage(
    params: UsageScope & {
      groupBy: AppUsageDimension[];
      appId?: string;
      /** App ids the caller may see; undefined means no restriction (admins). */
      accessibleAppIds?: string[];
    },
  ): Promise<AppUsageResponse> {
    const { groupBy, pagination } = params;
    const emptyTotals = {
      runs: 0,
      toolCalls: 0,
      llmRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      billedCost: 0,
      subscriptionCost: 0,
    };
    if (params.accessibleAppIds?.length === 0) {
      return {
        data: [],
        pagination: calculatePaginationMeta(0, pagination),
        totals: emptyTotals,
      };
    }

    const calls = schema.mcpToolCallsTable;
    const interactions = schema.interactionsTable;
    const apps = schema.appsTable;

    const scopedAppIds = db
      .select({ id: apps.id })
      .from(apps)
      .where(
        and(
          eq(apps.organizationId, params.organizationId),
          notDeleted(apps),
          ...(params.accessibleAppIds
            ? [inArray(apps.id, params.accessibleAppIds)]
            : []),
          ...(params.appId ? [eq(apps.id, params.appId)] : []),
        ),
      );

    // Both sources reduced to one fact shape, so a single GROUP BY can page
    // and order across them.
    const facts = sql`
      SELECT ${calls.appId} AS app_id, ${calls.userId} AS user_id, ${calls.createdAt} AS created_at,
        CASE WHEN ${calls.method} = 'tools/list' THEN 1 ELSE 0 END AS runs,
        CASE WHEN ${calls.method} = 'tools/call' THEN 1 ELSE 0 END AS tool_calls,
        0 AS llm_requests,
        0::bigint AS input_tokens,
        0::bigint AS output_tokens,
        0::double precision AS billed_cost,
        0::double precision AS subscription_cost
      FROM ${calls}
      WHERE ${and(
        eq(calls.ownerType, "app"),
        sql`${calls.appId} IN (${scopedAppIds})`,
        ...StatisticsModel.timeframeConditions(
          params.timeframe,
          calls.createdAt,
        ),
        ...userScopeConditions(calls.userId, params),
      )}
      UNION ALL
      SELECT ${interactions.appId}, ${interactions.userId}, ${interactions.createdAt},
        0, 0, 1,
        COALESCE(${interactions.inputTokens}, 0),
        COALESCE(${interactions.outputTokens}, 0),
        CASE WHEN ${interactions.billingMode} = 'metered' THEN COALESCE(${interactions.cost}, 0) ELSE 0 END,
        CASE WHEN ${interactions.billingMode} = 'subscription' THEN COALESCE(${interactions.cost}, 0) ELSE 0 END
      FROM ${interactions}
      WHERE ${and(
        sql`${interactions.appId} IN (${scopedAppIds})`,
        ...StatisticsModel.timeframeConditions(params.timeframe),
        ...userScopeConditions(interactions.userId, params),
      )}
    `;

    const dimensionColumns: Record<AppUsageDimension, Record<string, SQL>> = {
      day: {
        day: sql`to_char(date_trunc('day', facts.created_at at time zone 'UTC'), 'YYYY-MM-DD')`,
      },
      appId: { app_id: sql`facts.app_id`, app_name: sql`${apps.name}` },
      userId: {
        user_id: sql`facts.user_id`,
        user_name: sql`${schema.usersTable.name}`,
      },
    };
    const selected = selectDimensions(dimensionColumns, groupBy);
    const selectedEntries = Object.entries(selected);

    const metrics = sql`
      CAST(COALESCE(SUM(facts.runs), 0) AS INTEGER) AS runs,
      CAST(COALESCE(SUM(facts.tool_calls), 0) AS INTEGER) AS tool_calls,
      CAST(COALESCE(SUM(facts.llm_requests), 0) AS INTEGER) AS llm_requests,
      CAST(COALESCE(SUM(facts.input_tokens), 0) AS BIGINT) AS input_tokens,
      CAST(COALESCE(SUM(facts.output_tokens), 0) AS BIGINT) AS output_tokens,
      CAST(COALESCE(SUM(facts.billed_cost), 0) AS DOUBLE PRECISION) AS billed_cost,
      CAST(COALESCE(SUM(facts.subscription_cost), 0) AS DOUBLE PRECISION) AS subscription_cost`;

    const dayFirst = groupBy.includes("day") ? sql`day ASC, ` : sql``;
    const groupedQuery = sql`
        WITH facts AS (${facts})
        SELECT ${sql.join(
          selectedEntries.map(
            ([alias, expr]) => sql`${expr} AS ${sql.identifier(alias)}`,
          ),
          sql`, `,
        )},
          ${metrics},
          CAST(COUNT(*) OVER () AS INTEGER) AS total
        FROM facts
        LEFT JOIN ${apps} ON ${apps.id} = facts.app_id
        LEFT JOIN ${schema.usersTable} ON ${schema.usersTable.id} = facts.user_id
        GROUP BY ${sql.join(
          selectedEntries.map(([, expr]) => expr),
          sql`, `,
        )}
        ORDER BY ${dayFirst}runs DESC, llm_requests DESC, ${sql.join(
          selectedEntries.map(([alias]) => sql`${sql.identifier(alias)} ASC`),
          sql`, `,
        )}
      `;
    const [page, totals] = await Promise.all([
      db.execute<Record<string, unknown>>(
        sql`${groupedQuery} LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
      ),
      db.execute<Record<string, unknown>>(sql`
        WITH facts AS (${facts})
        SELECT ${metrics} FROM facts
      `),
    ]);

    const toMetrics = (row: Record<string, unknown>) => ({
      runs: Number(row.runs ?? 0),
      toolCalls: Number(row.tool_calls ?? 0),
      llmRequests: Number(row.llm_requests ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      billedCost: Number(row.billed_cost ?? 0),
      subscriptionCost: Number(row.subscription_cost ?? 0),
    });

    return {
      ...paginate(
        page.rows,
        pagination,
        (row) => ({
          ...(groupBy.includes("day") ? { day: String(row.day) } : {}),
          ...(groupBy.includes("appId")
            ? {
                appId: String(row.app_id),
                appName: (row.app_name as string | null) ?? null,
              }
            : {}),
          ...(groupBy.includes("userId")
            ? {
                userId: (row.user_id as string | null) ?? null,
                userName: (row.user_name as string | null) ?? null,
              }
            : {}),
          ...toMetrics(row),
        }),
        await emptyPageTotal(
          page.rows,
          pagination,
          async () =>
            (
              await db.execute<Record<string, unknown>>(
                sql`${groupedQuery} LIMIT 1`,
              )
            ).rows,
        ),
      ),
      totals: totals.rows[0] ? toMetrics(totals.rows[0]) : emptyTotals,
    };
  }

  /**
   * Skill activations and the context tokens they injected, from the skill
   * usage log. Skills outside `accessibleSkillIds` are excluded.
   */
  static async getSkillUsage(
    params: UsageScope & {
      groupBy: SkillUsageDimension[];
      skillId?: string;
      /** Skill ids the caller may see; undefined means no restriction (admins). */
      accessibleSkillIds?: string[];
    },
  ): Promise<SkillUsageResponse> {
    const { groupBy, pagination } = params;
    if (params.accessibleSkillIds?.length === 0) {
      return {
        data: [],
        pagination: calculatePaginationMeta(0, pagination),
        totals: { activations: 0, contextTokens: 0, users: 0 },
      };
    }

    const events = schema.skillUsageEventsTable;
    const skills = schema.skillsTable;

    const dimensionColumns: Record<
      SkillUsageDimension,
      Record<string, SQL | PgColumn>
    > = {
      day: { day: utcDay(events.createdAt) },
      skillId: { skillId: events.skillId, skillName: skills.name },
      userId: { userId: events.userId, userName: schema.usersTable.name },
    };
    const selected = selectDimensions(dimensionColumns, groupBy);

    const where = and(
      eq(skills.organizationId, params.organizationId),
      notDeleted(skills),
      ...StatisticsModel.timeframeConditions(
        params.timeframe,
        events.createdAt,
      ),
      ...userScopeConditions(events.userId, params),
      ...(params.accessibleSkillIds
        ? [inArray(events.skillId, params.accessibleSkillIds)]
        : []),
      ...(params.skillId ? [eq(events.skillId, params.skillId)] : []),
    );

    const activations = sql<number>`CAST(COUNT(*) AS INTEGER)`;
    const contextTokens = sql<number>`CAST(COALESCE(SUM(${events.contextTokens}), 0) AS BIGINT)`;
    const users = sql<number>`CAST(COUNT(DISTINCT ${events.userId}) AS INTEGER)`;

    const groupedQuery = db
      .select({
        ...selected,
        activations,
        contextTokens,
        users,
        total: TOTAL_GROUPS,
      })
      .from(events)
      .innerJoin(skills, eq(skills.id, events.skillId))
      .leftJoin(schema.usersTable, eq(schema.usersTable.id, events.userId))
      .where(where)
      .groupBy(...Object.values(selected));
    const [rows, [totals]] = await Promise.all([
      groupedQuery
        .orderBy(...usageOrder(selected, activations))
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ activations, contextTokens, users })
        .from(events)
        .innerJoin(skills, eq(skills.id, events.skillId))
        .where(where),
    ]);

    return {
      ...paginate(
        rows,
        pagination,
        (row) => ({
          ...row,
          activations: Number(row.activations),
          contextTokens: Number(row.contextTokens),
          users: Number(row.users),
        }),
        await emptyPageTotal(rows, pagination, () =>
          groupedQuery.limit(1).offset(0),
        ),
      ),
      totals: {
        activations: Number(totals?.activations ?? 0),
        contextTokens: Number(totals?.contextTokens ?? 0),
        users: Number(totals?.users ?? 0),
      },
    };
  }
}

export default UsageStatisticsModel;

// ===== Internal =====

interface UsageScope {
  timeframe: StatisticsTimeFrame;
  organizationId: string;
  pagination: PaginationQuery;
  /** Only this person's usage. */
  userId?: string;
  /** Only usage by direct members of this team. */
  teamId?: string;
  /**
   * Narrow to the caller's own usage. Set for callers who may not see other
   * members' activity.
   */
  restrictToUserId?: string;
}

const calls = schema.mcpToolCallsTable;

/** Whether the call's result was an error, with the same JSON fallback. */
const IS_ERROR = sql`COALESCE(${calls.isError}, CASE WHEN ${calls.encryptedChatConversationId} IS NULL AND jsonb_typeof(${calls.toolResult}) = 'object' THEN ${calls.toolResult}->>'isError' = 'true' END, FALSE)`;

/** Number of groups the query produced, before LIMIT/OFFSET. */
const TOTAL_GROUPS = sql<number>`CAST(COUNT(*) OVER () AS INTEGER)`;

function utcDay(column: AnyColumn): SQL<string> {
  return sql<string>`to_char(date_trunc('day', ${column} at time zone 'UTC'), 'YYYY-MM-DD')`;
}

/** The select (and GROUP BY) columns for the requested dimensions, in request order. */
function selectDimensions<D extends string, C extends SQL | PgColumn>(
  columns: Record<D, Record<string, C>>,
  groupBy: D[],
): Record<string, C> {
  return Object.assign({}, ...[...new Set(groupBy)].map((d) => columns[d]));
}

/** Days ascending (when grouped by day), then the main metric, then the dimensions. */
function usageOrder(
  selected: Record<string, SQL | PgColumn>,
  metric: SQL,
): SQL[] {
  const { day, ...rest } = selected;
  return [
    ...(day ? [asc(day)] : []),
    desc(metric),
    ...Object.values(rest).map((column) => asc(column)),
  ];
}

function userScopeConditions(
  userColumn: AnyColumn,
  params: Pick<
    UsageScope,
    "userId" | "teamId" | "restrictToUserId" | "organizationId"
  >,
): SQL[] {
  const conditions: SQL[] = [];
  if (params.restrictToUserId) {
    conditions.push(eq(userColumn, params.restrictToUserId));
  }
  if (params.userId) conditions.push(eq(userColumn, params.userId));
  if (params.teamId) {
    conditions.push(
      inArray(
        userColumn,
        db
          .select({ userId: schema.teamMembersTable.userId })
          .from(schema.teamMembersTable)
          .innerJoin(
            schema.teamsTable,
            eq(schema.teamsTable.id, schema.teamMembersTable.teamId),
          )
          .where(
            and(
              eq(schema.teamMembersTable.teamId, params.teamId),
              eq(schema.teamsTable.organizationId, params.organizationId),
            ),
          ),
      ),
    );
  }
  return conditions;
}

/** Strip the window total from each row and build the paginated envelope. */
function paginate<Row extends { total?: unknown }, Out>(
  rows: Row[],
  pagination: PaginationQuery,
  map: (row: Omit<Row, "total">) => Out,
  emptyTotal = 0,
) {
  const total = rows.length > 0 ? Number(rows[0].total) : emptyTotal;
  return {
    data: rows.map(({ total: _total, ...row }) => map(row)),
    pagination: calculatePaginationMeta(total, pagination),
  };
}

/** Preserve group counts even when the requested page lies past the last row. */
async function emptyPageTotal(
  rows: { total?: unknown }[],
  pagination: PaginationQuery,
  firstPage: () => PromiseLike<{ total?: unknown }[]>,
): Promise<number> {
  if (rows.length || pagination.offset === 0) return 0;
  const [first] = await firstPage();
  return Number(first?.total ?? 0);
}
