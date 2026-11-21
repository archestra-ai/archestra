import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import LlmUsageRollupModel from "@/models/llm-usage-rollup";
import {
  interactionBelongsToOrganization,
  mcpToolCallBelongsToOrganization,
} from "@/models/log-organization";

/**
 * The Logs page's reads that no other model serves. Every page is a keyset
 * read of the newest rows before a position, with the filters in SQL, and
 * selects no payloads. Counts come grouped: LLM Proxy from the hourly usage
 * rollup (raw rows only while searching), MCP and audit by hour in SQL.
 */
class LogFeedModel {
  /** LLM Proxy requests in `[from, to]` before `after`, newest first. */
  static async pageInteractions(params: {
    scope: Scope;
    from: Date;
    to: Date;
    after?: KeysetPosition;
    filters: InteractionFilters;
    limit: number;
  }) {
    const i = schema.interactionsTable;
    return db
      .select({
        id: i.id,
        createdAt: i.createdAt,
        sessionId: i.sessionId,
        userId: i.userId,
        userName: schema.usersTable.name,
        userEmail: schema.usersTable.email,
        agentId: schema.agentsTable.id,
        agentName: schema.agentsTable.name,
        agentType: schema.agentsTable.agentType,
        externalAgentId: i.externalAgentId,
        source: i.source,
        type: i.type,
        model: i.model,
        inputTokens: i.inputTokens,
        outputTokens: i.outputTokens,
        cacheReadTokens: i.cacheReadTokens,
        cost: i.cost,
        billingMode: i.billingMode,
        durationMs: i.durationMs,
        failed: i.failed,
      })
      .from(i)
      .leftJoin(schema.usersTable, eq(i.userId, schema.usersTable.id))
      .leftJoin(schema.agentsTable, eq(i.profileId, schema.agentsTable.id))
      .where(
        and(
          interactionBelongsToOrganization(params.scope.organizationId),
          gte(i.createdAt, params.from),
          lte(i.createdAt, params.to),
          params.scope.userId ? eq(i.userId, params.scope.userId) : undefined,
          before(i.createdAt, i.id, params.after, "timestamp"),
          ...interactionConditions(params.filters),
        ),
      )
      .orderBy(desc(i.createdAt), desc(i.id))
      .limit(params.limit);
  }

  /**
   * LLM Proxy requests per hour and key, from the usage rollup. It holds no
   * session ids or names to search, so a search reads
   * {@link searchedInteractionFacts} instead.
   */
  static async interactionFacts(params: {
    scope: Scope;
    from: Date;
    to: Date;
  }): Promise<InteractionFact[]> {
    const f = LlmUsageRollupModel.facts(
      await LlmUsageRollupModel.window(
        `custom:${params.from.toISOString()}_${params.to.toISOString()}`,
      ),
    );
    const hour = sql`date_trunc('hour', ${f.hour})`;
    return db
      .select({
        hour: hour.mapWith(toUtcDate),
        userId: f.userId,
        profileId: f.profileId,
        model: f.model,
        externalAgentId: f.externalAgentId,
        source: f.source,
        type: f.type,
        requests: sql`SUM(${f.requests})::integer`.mapWith(Number),
        failed: sql`SUM(${f.failedRequests})::integer`.mapWith(Number),
      })
      .from(f)
      .where(
        and(
          interactionBelongsToOrganization(params.scope.organizationId, f),
          params.scope.userId ? eq(f.userId, params.scope.userId) : undefined,
        ),
      )
      .groupBy(
        hour,
        f.userId,
        f.profileId,
        f.model,
        f.externalAgentId,
        f.source,
        f.type,
      );
  }

  /** {@link interactionFacts} for a search, counted from raw rows. */
  static async searchedInteractionFacts(params: {
    scope: Scope;
    from: Date;
    to: Date;
    filters: Pick<InteractionFilters, "q" | "sessionId">;
  }): Promise<InteractionFact[]> {
    const i = schema.interactionsTable;
    const hour = sql`date_trunc('hour', ${i.createdAt})`;
    return db
      .select({
        hour: hour.mapWith(toUtcDate),
        userId: i.userId,
        profileId: i.profileId,
        model: i.model,
        externalAgentId: i.externalAgentId,
        source: i.source,
        type: i.type,
        requests: count(),
        failed: sql`(COUNT(*) FILTER (WHERE ${i.failed}))::integer`.mapWith(
          Number,
        ),
      })
      .from(i)
      .leftJoin(schema.usersTable, eq(i.userId, schema.usersTable.id))
      .leftJoin(schema.agentsTable, eq(i.profileId, schema.agentsTable.id))
      .where(
        and(
          interactionBelongsToOrganization(params.scope.organizationId),
          gte(i.createdAt, params.from),
          lte(i.createdAt, params.to),
          params.scope.userId ? eq(i.userId, params.scope.userId) : undefined,
          ...interactionConditions(params.filters),
        ),
      )
      .groupBy(
        hour,
        i.userId,
        i.profileId,
        i.model,
        i.externalAgentId,
        i.source,
        i.type,
      );
  }

  /** MCP Gateway tool calls in `[from, to]` before `after`, newest first. */
  static async pageToolCalls(params: {
    scope: Scope;
    from: Date;
    to: Date;
    after?: KeysetPosition;
    filters: ToolCallFilters;
    limit: number;
  }) {
    const m = schema.mcpToolCallsTable;
    return db
      .select({
        id: m.id,
        createdAt: m.createdAt,
        userId: m.userId,
        userName: schema.usersTable.name,
        agentId: schema.agentsTable.id,
        agentName: schema.agentsTable.name,
        agentType: schema.agentsTable.agentType,
        mcpServerName: m.mcpServerName,
        toolName: m.toolName,
        method: m.method,
        authMethod: m.authMethod,
        isError: m.isError,
        durationMs: m.durationMs,
        sessionId: m.sessionId,
      })
      .from(m)
      .leftJoin(schema.usersTable, eq(m.userId, schema.usersTable.id))
      .leftJoin(schema.agentsTable, eq(m.agentId, schema.agentsTable.id))
      .where(
        and(
          mcpToolCallBelongsToOrganization(params.scope.organizationId),
          gte(m.createdAt, params.from),
          lte(m.createdAt, params.to),
          params.scope.userId ? eq(m.userId, params.scope.userId) : undefined,
          before(m.createdAt, m.id, params.after, "timestamp"),
          ...toolCallConditions(params.filters),
        ),
      )
      .orderBy(desc(m.createdAt), desc(m.id))
      .limit(params.limit);
  }

  /** MCP Gateway tool calls per hour, person, agent, server, and outcome. */
  static async toolCallFacts(params: {
    scope: Scope;
    from: Date;
    to: Date;
    filters: Pick<ToolCallFilters, "q" | "sessionId">;
  }) {
    const m = schema.mcpToolCallsTable;
    const hour = sql`date_trunc('hour', ${m.createdAt})`;
    const isError = sql`COALESCE(${m.isError}, false)`;
    return db
      .select({
        hour: hour.mapWith(toUtcDate),
        userId: m.userId,
        userName: schema.usersTable.name,
        agentId: m.agentId,
        agentName: schema.agentsTable.name,
        agentType: schema.agentsTable.agentType,
        mcpServerName: m.mcpServerName,
        isError: isError.mapWith(Boolean),
        count: count(),
      })
      .from(m)
      .leftJoin(schema.usersTable, eq(m.userId, schema.usersTable.id))
      .leftJoin(schema.agentsTable, eq(m.agentId, schema.agentsTable.id))
      .where(
        and(
          mcpToolCallBelongsToOrganization(params.scope.organizationId),
          gte(m.createdAt, params.from),
          lte(m.createdAt, params.to),
          params.scope.userId ? eq(m.userId, params.scope.userId) : undefined,
          ...toolCallConditions(params.filters),
        ),
      )
      .groupBy(
        hour,
        m.userId,
        schema.usersTable.name,
        m.agentId,
        schema.agentsTable.name,
        schema.agentsTable.agentType,
        m.mcpServerName,
        isError,
      );
  }

  /** Audit events in `[from, to]` before `after`, newest first. */
  static async pageAuditEvents(params: {
    scope: Scope;
    from: Date;
    to: Date;
    after?: KeysetPosition;
    filters: AuditFilters;
    limit: number;
  }) {
    const a = schema.auditLogsTable;
    return db
      .select({
        id: a.id,
        createdAt: a.createdAt,
        actorType: a.actorType,
        actorName: a.actorName,
        actorEmail: a.actorEmail,
        action: a.action,
        outcome: a.outcome,
        resourceType: a.resourceType,
        resourceName: a.resourceName,
        httpMethod: a.httpMethod,
        httpStatus: a.httpStatus,
        sourceIp: a.sourceIp,
      })
      .from(a)
      .where(
        and(
          ...auditScope(params),
          before(a.createdAt, a.id, params.after, "timestamptz"),
          ...auditConditions(params.filters),
        ),
      )
      .orderBy(desc(a.createdAt), desc(a.id))
      .limit(params.limit);
  }

  /** Audit events per hour, actor, action, resource, and outcome. */
  static async auditFacts(params: {
    scope: Scope;
    from: Date;
    to: Date;
    filters: Pick<AuditFilters, "q">;
  }) {
    const a = schema.auditLogsTable;
    const hour = sql`date_trunc('hour', ${a.createdAt} AT TIME ZONE 'UTC')`;
    return db
      .select({
        hour: hour.mapWith(toUtcDate),
        actorType: a.actorType,
        actorName: a.actorName,
        actorEmail: a.actorEmail,
        action: a.action,
        outcome: a.outcome,
        resourceType: a.resourceType,
        resourceName: a.resourceName,
        count: count(),
      })
      .from(a)
      .where(and(...auditScope(params), ...auditConditions(params.filters)))
      .groupBy(
        hour,
        a.actorType,
        a.actorName,
        a.actorEmail,
        a.action,
        a.outcome,
        a.resourceType,
        a.resourceName,
      );
  }

  /** The audit actions recorded in the window, to resolve a label filter. */
  static async auditActions(params: {
    scope: Scope;
    from: Date;
    to: Date;
  }): Promise<string[]> {
    const a = schema.auditLogsTable;
    const rows = await db
      .selectDistinct({ action: a.action })
      .from(a)
      .where(and(...auditScope(params)));
    return rows.map((row) => row.action);
  }

  static async findUserNames(
    ids: string[],
  ): Promise<Map<string, { name: string; email: string }>> {
    if (!ids.length) return new Map();
    const rows = await db
      .select({
        id: schema.usersTable.id,
        name: schema.usersTable.name,
        email: schema.usersTable.email,
      })
      .from(schema.usersTable)
      .where(inArray(schema.usersTable.id, ids));
    return new Map(rows.map(({ id, ...user }) => [id, user]));
  }

  static async findAgentNames(
    ids: string[],
  ): Promise<Map<string, { name: string; agentType: string }>> {
    if (!ids.length) return new Map();
    const rows = await db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        agentType: schema.agentsTable.agentType,
      })
      .from(schema.agentsTable)
      .where(inArray(schema.agentsTable.id, ids));
    return new Map(rows.map(({ id, ...agent }) => [id, agent]));
  }
}

export default LogFeedModel;

/** Whose records a read covers: the organization's, or one member's. */
export type Scope = {
  organizationId: string;
  /** Only this user's records; everyone's when left out. */
  userId?: string;
};

/** The last row a page has shown: read only rows before it. */
export type KeysetPosition = { at: string; id: string };

type InteractionFilters = {
  failed?: boolean;
  agentName?: string;
  /** A user's name; "System" for requests no user made. */
  actorName?: string;
  model?: string;
  sessionId?: string;
  q?: string;
  client?: ClientMatch;
};

/** Which requests a Client filter value names (see the Logs service). */
export type ClientMatch = {
  externalAgentIds?: readonly string[];
  sources?: readonly string[];
  /** Requests a known coding client sent belong to that client instead. */
  notExternalAgentIds: readonly string[];
};

type ToolCallFilters = {
  isError?: boolean;
  agentName?: string;
  actorName?: string;
  mcpServerName?: string;
  sessionId?: string;
  q?: string;
};

export type AuditFilters = {
  actions?: readonly string[];
  actorName?: string;
  actorTypes?: readonly string[];
  resourceType?: string;
  resourceName?: string;
  outcomes?: readonly string[];
  q?: string;
};

type InteractionFact = {
  hour: Date;
  userId: string | null;
  profileId: string | null;
  model: string | null;
  externalAgentId: string | null;
  source: string | null;
  type: string;
  requests: number;
  failed: number;
};

// === Internal helpers

/**
 * Rows before a keyset position. Times compare at millisecond precision, the
 * precision the position was read at; the plain bound keeps the time index
 * usable.
 */
function before(
  at: SQLWrapper,
  id: SQLWrapper,
  position: KeysetPosition | undefined,
  cast: "timestamp" | "timestamptz",
): SQL | undefined {
  if (!position) return undefined;
  const value = sql`${position.at}::${sql.raw(cast)}`;
  return and(
    sql`${at} < ${value} + interval '1 millisecond'`,
    sql`(date_trunc('milliseconds', ${at}), ${id}::text) < (${value}, ${position.id})`,
  );
}

function interactionConditions(
  filters: InteractionFilters,
): (SQL | undefined)[] {
  const i = schema.interactionsTable;
  const users = schema.usersTable;
  const agents = schema.agentsTable;
  const client = filters.client;
  return [
    filters.failed === true ? eq(i.failed, true) : undefined,
    filters.failed === false
      ? sql`COALESCE(${i.failed}, false) = false`
      : undefined,
    filters.agentName ? eq(agents.name, filters.agentName) : undefined,
    actorCondition(i.userId, filters.actorName),
    filters.model ? eq(i.model, filters.model) : undefined,
    filters.sessionId ? eq(i.sessionId, filters.sessionId) : undefined,
    filters.q
      ? searchCondition(filters.q, {
          exact: [i.sessionId, sql`${i.id}::text`],
          partial: [
            i.model,
            users.name,
            users.email,
            agents.name,
            i.externalAgentId,
            i.source,
          ],
        })
      : undefined,
    client
      ? and(
          client.externalAgentIds
            ? inList(i.externalAgentId, client.externalAgentIds)
            : undefined,
          client.sources ? inList(i.source, client.sources) : undefined,
          client.externalAgentIds || !client.notExternalAgentIds.length
            ? undefined
            : or(
                isNull(i.externalAgentId),
                sql`NOT (${inList(i.externalAgentId, client.notExternalAgentIds)})`,
              ),
        )
      : undefined,
  ];
}

function toolCallConditions(filters: ToolCallFilters): (SQL | undefined)[] {
  const m = schema.mcpToolCallsTable;
  return [
    filters.isError === true ? eq(m.isError, true) : undefined,
    filters.isError === false
      ? sql`COALESCE(${m.isError}, false) = false`
      : undefined,
    filters.agentName
      ? eq(schema.agentsTable.name, filters.agentName)
      : undefined,
    actorCondition(m.userId, filters.actorName),
    filters.mcpServerName
      ? eq(m.mcpServerName, filters.mcpServerName)
      : undefined,
    filters.sessionId ? eq(m.sessionId, filters.sessionId) : undefined,
    filters.q
      ? searchCondition(filters.q, {
          exact: [m.sessionId, sql`${m.id}::text`],
          partial: [
            m.toolName,
            m.mcpServerName,
            schema.usersTable.name,
            schema.agentsTable.name,
          ],
        })
      : undefined,
  ];
}

function auditScope(params: { scope: Scope; from: Date; to: Date }) {
  const a = schema.auditLogsTable;
  return [
    eq(a.organizationId, params.scope.organizationId),
    gte(a.createdAt, params.from),
    lte(a.createdAt, params.to),
    params.scope.userId ? eq(a.actorId, params.scope.userId) : undefined,
  ];
}

function auditConditions(filters: AuditFilters): (SQL | undefined)[] {
  const a = schema.auditLogsTable;
  const actor = sql`COALESCE(${a.actorName}, ${a.actorEmail}, 'Unknown')`;
  const resourceType = sql`COALESCE(${a.resourceType}, split_part(${a.action}, '.', 1))`;
  return [
    filters.actions ? inList(a.action, filters.actions) : undefined,
    filters.actorTypes ? inList(a.actorType, filters.actorTypes) : undefined,
    filters.outcomes ? inList(a.outcome, filters.outcomes) : undefined,
    filters.actorName ? sql`${actor} = ${filters.actorName}` : undefined,
    filters.resourceType
      ? sql`${resourceType} = ${filters.resourceType}`
      : undefined,
    filters.resourceName !== undefined
      ? sql`COALESCE(${a.resourceName}, '') = ${filters.resourceName}`
      : undefined,
    filters.q
      ? searchCondition(filters.q, {
          exact: [sql`${a.id}::text`],
          partial: [
            a.action,
            a.resourceName,
            a.resourceType,
            a.actorName,
            a.actorEmail,
          ],
        })
      : undefined,
  ];
}

/** A user's name; "System" is the records no user made. */
function actorCondition(userId: SQLWrapper, name: string | undefined) {
  if (!name) return undefined;
  if (name === "System") return sql`${userId} IS NULL`;
  return eq(schema.usersTable.name, name);
}

/** Exact ids, or a case-insensitive substring of any named field. */
function searchCondition(
  q: string,
  fields: { exact: SQLWrapper[]; partial: SQLWrapper[] },
): SQL | undefined {
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return or(
    ...fields.exact.map((field) => sql`${field} = ${q}`),
    ...fields.partial.map((field) => sql`${field} ILIKE ${pattern}`),
  );
}

/** `column IN (values)`; no values matches nothing. */
function inList(column: SQLWrapper, values: readonly string[]): SQL {
  if (!values.length) return sql`false`;
  return sql`${column} IN (${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}

/** A `timestamp` holds UTC wall time; read it as that instant. */
function toUtcDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const text = String(value);
  return new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
}
