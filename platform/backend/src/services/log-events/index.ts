import {
  CLIENT_FILTER_OPTIONS,
  clientFilterToAgentIds,
  clientForExternalAgentIds,
  INTERACTION_SOURCE_DISPLAY,
  type InteractionSource,
  type SupportedProvider,
  SupportedProvidersSchema,
} from "@archestra/shared";
import { userHasPermission } from "@/auth";
import { LRUCacheManager } from "@/cache-manager";
import { encodeCursor } from "@/database/utils/pagination";
import { ConnectedClientModel, LogFeedModel } from "@/models";
import type {
  AuditFilters,
  ClientMatch,
  KeysetPosition,
  Scope,
} from "@/models/log-feed";
import { listGuardrailEvents } from "@/services/openappa-guardrail-events";
import { ApiError } from "@/types";
import type {
  LogEvent,
  LogEventsPage,
  LogEventsQuery,
  LogSource,
  LogStats,
  LogStatsQuery,
  LogStatus,
} from "@/types/log-events";
import { decodeFeedCursor, type LogFact, mergePages, summarize } from "./feed";

/**
 * The Logs page's one timeline. Each type is read under its own permission,
 * `read` for the caller's own records and `admin` for everyone's: `log` for
 * LLM Proxy and MCP Gateway, `guardrailsLog`, `clientConnection`, and
 * `auditLog`. A type the caller cannot read is left out; a caller who can
 * read none is refused.
 *
 * A page reads at most `limit + 1` rows of each type, after that type's own
 * position in the cursor, with every filter in SQL. LLM Proxy and MCP Gateway
 * read widening slices back from the position, so a page of a busy window
 * touches its newest hour, not the whole window.
 */
export async function listLogEvents(params: {
  organizationId: string;
  userId: string;
  query: LogEventsQuery;
}): Promise<LogEventsPage> {
  const { query } = params;
  const access = await readAccess(params);
  const window = windowOf(query.hours, new Date());
  const cursor = decodeFeedCursor(query.cursor);
  const sources = sourcesFor(access, query).filter(
    (source) => cursor[source] !== "end",
  );
  const pages = Object.fromEntries(
    await Promise.all(
      sources.map(async (source) => {
        const position = cursor[source];
        const read: PageRead = {
          scope: scopeOf(params, access[source]),
          callerId: params.userId,
          ...window,
          after: position && position !== "end" ? position : undefined,
          query,
          need: query.limit + 1,
        };
        return [source, await PAGE_READERS[source](read)] as const;
      }),
    ),
  ) as Partial<Record<LogSource, LogEvent[]>>;
  return mergePages({ pages, cursor, limit: query.limit });
}

/**
 * Counts for the events the filters match in the window, from grouped reads:
 * LLM Proxy from the hourly usage rollup (raw rows while searching), MCP
 * Gateway and audit grouped by hour in SQL, and the two small types from
 * their events. A picked type reads only its own counts.
 */
export async function getLogStats(params: {
  organizationId: string;
  userId: string;
  query: LogStatsQuery;
}): Promise<LogStats> {
  const { query } = params;
  const access = await readAccess(params);
  // A minute's grain, so the requests of one page view share cached reads.
  const now = new Date(Math.ceil(Date.now() / 60_000) * 60_000);
  const window = windowOf(query.hours, now);
  const sources = readableSources(access).filter(
    (source) => !query.sources.length || query.sources.includes(source),
  );
  const results = await Promise.all(
    sources.map((source) => {
      const read: FactRead = {
        scope: scopeOf(params, access[source]),
        callerId: params.userId,
        ...window,
        q: query.q?.trim() || undefined,
        sessionId: query.sessionId,
      };
      const key = JSON.stringify([source, read]);
      const cached = factCache.get(key);
      if (cached) return cached;
      const pending = FACT_READERS[source](read);
      factCache.set(key, pending);
      pending.catch(() => factCache.delete(key));
      return pending;
    }),
  );
  return summarize({
    facts: results.flatMap((r) => r.facts),
    query,
    ...window,
    truncated: results.some((r) => r.truncated),
  });
}

// === Internal helpers

type Access = "none" | "read" | "admin";
type AccessBySource = Record<LogSource, Access>;

type Window = { from: Date; to: Date };

type Read = Window & {
  scope: Scope;
  /** Who is asking; Guardrails scopes its records to them itself. */
  callerId: string;
};

type PageRead = Read & {
  after?: KeysetPosition;
  query: LogStatsQuery;
  need: number;
};

type FactRead = Read & { q?: string; sessionId?: string };
type FactResult = { facts: LogFact[]; truncated: boolean };

const HOUR = 3_600_000;

/** Slices a page reads back from its position, in hours, before the rest. */
const SLICES = [1, 6, 24];

/** Events the two small types read for counts; more marks counts truncated. */
const SMALL_TYPE_CAP = 2_000;

/** Batches a small type reads to fill one page of in-memory filtered rows. */
const MAX_BATCHES = 20;

const factCache = new LRUCacheManager<Promise<FactResult>>({
  maxSize: 200,
  defaultTtl: 30_000,
});

const PAGE_READERS: Record<LogSource, (read: PageRead) => Promise<LogEvent[]>> =
  {
    llm: pageLlm,
    mcp: pageMcp,
    guardrails: pageGuardrails,
    connections: pageConnections,
    audit: pageAudit,
  };

const FACT_READERS: Record<LogSource, (read: FactRead) => Promise<FactResult>> =
  {
    llm: llmFacts,
    mcp: mcpFacts,
    guardrails: guardrailFacts,
    connections: connectionFacts,
    audit: auditFacts,
  };

function windowOf(hours: number, to: Date): Window {
  return { from: new Date(to.getTime() - hours * HOUR), to };
}

async function readAccess(params: {
  organizationId: string;
  userId: string;
}): Promise<AccessBySource> {
  // Permissions load once per request; each check reads the same grants.
  const level = async (
    resource: "log" | "guardrailsLog" | "clientConnection" | "auditLog",
  ): Promise<Access> => {
    const [read, admin] = await Promise.all([
      userHasPermission(params.userId, params.organizationId, resource, "read"),
      userHasPermission(
        params.userId,
        params.organizationId,
        resource,
        "admin",
      ),
    ]);
    return !read ? "none" : admin ? "admin" : "read";
  };
  const [log, guardrails, connections, audit] = await Promise.all([
    level("log"),
    level("guardrailsLog"),
    level("clientConnection"),
    level("auditLog"),
  ]);
  const access = { llm: log, mcp: log, guardrails, connections, audit };
  if (!readableSources(access).length) {
    throw new ApiError(
      403,
      "Reading Logs requires log:read, guardrailsLog:read, clientConnection:read, or auditLog:read",
    );
  }
  return access;
}

function readableSources(access: AccessBySource): LogSource[] {
  return (Object.keys(access) as LogSource[]).filter(
    (source) => access[source] !== "none",
  );
}

function scopeOf(
  params: { organizationId: string; userId: string },
  access: Access,
): Scope {
  return {
    organizationId: params.organizationId,
    userId: access === "admin" ? undefined : params.userId,
  };
}

/**
 * The types a page reads: readable, picked, and holding the fields every set
 * filter names. A model filter leaves out every type but LLM Proxy.
 */
function sourcesFor(access: AccessBySource, query: LogStatsQuery): LogSource[] {
  return readableSources(access).filter((source) => {
    if (query.sources.length && !query.sources.includes(source)) return false;
    const has = FIELDS[source];
    if (
      query.statuses.length &&
      !query.statuses.some((s) => has.statuses.includes(s as LogStatus))
    )
      return false;
    return FILTER_FIELDS.every((field) => {
      const value = query[field];
      const set = Array.isArray(value) ? value.length > 0 : !!value;
      return !set || has.fields.includes(field);
    });
  });
}

const FILTER_FIELDS = [
  "agent",
  "client",
  "model",
  "mcpServer",
  "decision",
  "connectionAction",
  "auditAction",
  "auditCategory",
  "resourceType",
  "resourceName",
  "actorKind",
  "sessionId",
] as const satisfies (keyof LogStatsQuery)[];

const FIELDS: Record<
  LogSource,
  { statuses: LogStatus[]; fields: (typeof FILTER_FIELDS)[number][] }
> = {
  llm: {
    statuses: ["ok", "error"],
    fields: ["agent", "client", "model", "sessionId"],
  },
  mcp: {
    statuses: ["ok", "error"],
    fields: ["agent", "mcpServer", "sessionId"],
  },
  guardrails: {
    statuses: ["ok", "error", "warning"],
    fields: ["decision", "sessionId"],
  },
  connections: { statuses: ["ok"], fields: ["client", "connectionAction"] },
  audit: {
    statuses: ["ok", "error", "blocked"],
    fields: [
      "auditAction",
      "auditCategory",
      "resourceType",
      "resourceName",
      "actorKind",
    ],
  },
};

/** ok/error statuses as a `failed` filter: both or neither is no filter. */
function failedFilter(statuses: string[]): boolean | undefined {
  const ok = statuses.includes("ok");
  const error = statuses.includes("error");
  return ok === error ? undefined : error;
}

/**
 * Reads newest-first slices back from the position (an hour, six, a day,
 * then the rest of the window) until a page fills, so a page of a busy
 * window touches its newest rows and the planner never sorts the window.
 */
async function sliced<T extends { id: string }>(
  read: PageRead,
  fetch: (from: Date, to: Date, limit: number) => Promise<T[]>,
): Promise<T[]> {
  const upper = read.after ? new Date(Date.parse(read.after.at) + 1) : read.to;
  const rows: T[] = [];
  const seen = new Set<string>();
  let to = upper;
  for (const hours of [...SLICES, Number.POSITIVE_INFINITY]) {
    const from = new Date(
      Math.max(read.from.getTime(), upper.getTime() - hours * HOUR),
    );
    if (from > to) continue;
    for (const row of await fetch(from, to, read.need - rows.length)) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        rows.push(row);
      }
    }
    if (rows.length >= read.need || from <= read.from) break;
    to = from;
  }
  return rows;
}

async function pageLlm(read: PageRead): Promise<LogEvent[]> {
  const { query } = read;
  const rows = await sliced(read, (from, to, limit) =>
    LogFeedModel.pageInteractions({
      scope: read.scope,
      from,
      to,
      after: read.after,
      limit,
      filters: {
        failed: failedFilter(query.statuses),
        agentName: query.agent,
        actorName: query.actor,
        model: query.model,
        sessionId: query.sessionId,
        q: query.q?.trim() || undefined,
        client: query.client ? clientMatch(query.client) : undefined,
      },
    }),
  );
  return rows.map(
    (row): LogEvent => ({
      id: row.id,
      source: "llm",
      timestamp: row.createdAt.toISOString(),
      status: row.failed ? "error" : "ok",
      title: row.model ?? "Unknown model",
      actor: row.userId
        ? {
            kind: "user",
            name: row.userName ?? "Unknown user",
            email: row.userEmail ?? undefined,
          }
        : { kind: "system", name: "System" },
      agent: agentOf(row.agentId, row.agentName, row.agentType),
      client: clientOf(row.externalAgentId, row.source),
      sessionId: row.sessionId ?? undefined,
      durationMs: row.durationMs ?? undefined,
      href: row.sessionId
        ? `/llm/logs/${encodeURIComponent(row.sessionId)}?request=${row.id}`
        : `/llm/logs/${row.id}`,
      llm: {
        provider: providerOf(row.type),
        model: row.model ?? "Unknown model",
        inputTokens: row.inputTokens ?? 0,
        outputTokens: row.outputTokens ?? 0,
        cacheReadTokens: row.cacheReadTokens ?? 0,
        cost: Number(row.cost ?? 0),
        billingMode: row.billingMode,
        stream: false,
        toolCallsRequested: 0,
      },
    }),
  );
}

async function pageMcp(read: PageRead): Promise<LogEvent[]> {
  const { query } = read;
  const rows = await sliced(read, (from, to, limit) =>
    LogFeedModel.pageToolCalls({
      scope: read.scope,
      from,
      to,
      after: read.after,
      limit,
      filters: {
        isError: failedFilter(query.statuses),
        agentName: query.agent,
        actorName: query.actor,
        mcpServerName: query.mcpServer,
        sessionId: query.sessionId,
        q: query.q?.trim() || undefined,
      },
    }),
  );
  return rows.map(
    (row): LogEvent => ({
      id: row.id,
      source: "mcp",
      timestamp: row.createdAt.toISOString(),
      status: row.isError ? "error" : "ok",
      title: row.toolName ?? row.method,
      actor: row.userId
        ? { kind: "user", name: row.userName ?? "Unknown user" }
        : { kind: "system", name: "System" },
      agent: agentOf(row.agentId, row.agentName, row.agentType),
      sessionId: row.sessionId ?? undefined,
      durationMs: row.durationMs ?? undefined,
      href: `/mcp/logs/${row.id}`,
      mcp: {
        server: row.mcpServerName,
        tool: row.toolName ?? undefined,
        method: row.method,
        authMethod: row.authMethod ?? "unknown",
      },
    }),
  );
}

async function pageAudit(read: PageRead): Promise<LogEvent[]> {
  const filters = await auditFilters(read);
  if (!filters) return [];
  const rows = await LogFeedModel.pageAuditEvents({
    scope: read.scope,
    from: read.from,
    to: read.to,
    after: read.after,
    limit: read.need,
    filters,
  });
  return rows.map((row): LogEvent => {
    const event = auditEventOf(row);
    return {
      id: row.id,
      source: "audit",
      timestamp: row.createdAt.toISOString(),
      status: event.status,
      title: event.audit.action,
      summary: row.resourceName ?? undefined,
      actor: event.actor,
      href: `/audit/logs/${row.id}`,
      audit: {
        ...event.audit,
        httpMethod: row.httpMethod ?? "",
        statusCode: row.httpStatus ?? 0,
        ip: row.sourceIp ?? "",
      },
    };
  });
}

/** The audit filters in SQL terms; null when they can match nothing. */
async function auditFilters(read: PageRead): Promise<AuditFilters | null> {
  const { query } = read;
  let actions: string[] | undefined;
  if (query.auditAction || query.auditCategory) {
    actions = (await LogFeedModel.auditActions(read)).filter(
      (action) =>
        (!query.auditAction || actionLabel(action) === query.auditAction) &&
        (!query.auditCategory || categoryOf(action) === query.auditCategory),
    );
  }
  const outcomes = query.statuses.length
    ? query.statuses.flatMap((status) => AUDIT_OUTCOME[status] ?? [])
    : undefined;
  const actorTypes = query.actorKind
    ? (ACTOR_TYPES[query.actorKind] ?? [])
    : undefined;
  if (outcomes?.length === 0 || actorTypes?.length === 0) return null;
  return {
    actions,
    outcomes,
    actorTypes,
    actorName: query.actor,
    resourceType: query.resourceType,
    resourceName: query.resourceName,
    q: query.q?.trim() || undefined,
  };
}

/**
 * Guardrails and connections hold few rows, so the filters their readers do
 * not take run here, reading on until the page fills.
 */
async function pageGuardrails(read: PageRead): Promise<LogEvent[]> {
  const { query } = read;
  const type =
    query.decision.length === 1 && query.decision[0] === "yell"
      ? "yell"
      : query.decision.length && !query.decision.includes("yell")
        ? "consult"
        : "all";
  return fill(read, async (cursor, limit) => {
    const { data, pagination } = await listGuardrailEvents({
      organizationId: read.scope.organizationId,
      userId: read.callerId,
      query: {
        type,
        search: query.q?.trim() || undefined,
        from: read.from,
        to: read.to,
        yellStatus: "all",
      },
      limit,
      cursor,
    });
    const users = await LogFeedModel.findUserNames([
      ...new Set(
        data.flatMap((row) => {
          const callerId =
            row.type === "consult" ? row.consult.callerId : row.yell.callerId;
          return callerId?.startsWith("user:") ? [callerId.slice(5)] : [];
        }),
      ),
    ]);
    return {
      events: data.map((row) => guardrailEventOf(row, users)),
      next: pagination.nextCursor,
    };
  });
}

async function pageConnections(read: PageRead): Promise<LogEvent[]> {
  const { query } = read;
  return fill(read, async (cursor, limit) => {
    const { data, pagination } = await ConnectedClientModel.listEvents({
      organizationId: read.scope.organizationId,
      pagination: { limit, cursor },
      userId: read.scope.userId,
      action:
        query.connectionAction === "connected" ||
        query.connectionAction === "disconnected"
          ? query.connectionAction
          : undefined,
      startDate: read.from.toISOString(),
      endDate: read.to.toISOString(),
    });
    return { events: data.map(connectionEventOf), next: pagination.nextCursor };
  });
}

/** Reads batches until `need` events pass the in-memory filters. */
async function fill(
  read: PageRead,
  batch: (
    cursor: string | undefined,
    limit: number,
  ) => Promise<{ events: LogEvent[]; next: string | null }>,
): Promise<LogEvent[]> {
  const out: LogEvent[] = [];
  let cursor = read.after
    ? encodeCursor({ value: read.after.at, id: read.after.id })
    : undefined;
  const limit = Math.max(read.need, 100);
  for (let i = 0; i < MAX_BATCHES && out.length < read.need; i++) {
    const { events, next } = await batch(cursor, limit);
    out.push(...events.filter((e) => matchesInMemory(e, read.query)));
    if (!next) break;
    cursor = next;
  }
  return out.slice(0, read.need);
}

/** The filters the guardrails and connections readers do not apply. */
function matchesInMemory(e: LogEvent, query: LogStatsQuery): boolean {
  const q = query.q?.toLowerCase().trim();
  return (
    (!query.statuses.length || query.statuses.includes(e.status)) &&
    (!query.sessionId || e.sessionId === query.sessionId) &&
    (!query.actor || e.actor.name === query.actor) &&
    (!query.client || e.client === query.client) &&
    (!query.decision.length ||
      (!!e.guardrail && query.decision.includes(e.guardrail.decision))) &&
    (!query.connectionAction ||
      e.connection?.action === query.connectionAction) &&
    // The guardrails reader searches itself.
    (!q || e.source === "guardrails" || haystack(e).includes(q))
  );
}

async function llmFacts(read: FactRead): Promise<FactResult> {
  const rows =
    read.q || read.sessionId
      ? await LogFeedModel.searchedInteractionFacts({
          ...read,
          filters: { q: read.q, sessionId: read.sessionId },
        })
      : await LogFeedModel.interactionFacts(read);
  const [users, agents] = await Promise.all([
    LogFeedModel.findUserNames([
      ...new Set(rows.flatMap((r) => (r.userId ? [r.userId] : []))),
    ]),
    LogFeedModel.findAgentNames([
      ...new Set(rows.flatMap((r) => (r.profileId ? [r.profileId] : []))),
    ]),
  ]);
  const facts = rows.flatMap((row): LogFact[] => {
    const user = row.userId ? users.get(row.userId) : undefined;
    const agent = row.profileId ? agents.get(row.profileId) : undefined;
    const base = {
      source: "llm" as const,
      hour: row.hour.getTime(),
      actor: row.userId
        ? {
            kind: "user" as const,
            name: user?.name ?? "Unknown user",
            email: user?.email,
          }
        : { kind: "system" as const, name: "System" },
      agent: agentOf(row.profileId, agent?.name, agent?.agentType),
      client: clientOf(row.externalAgentId, row.source as InteractionSource),
      model: row.model ?? "Unknown model",
      provider: providerOf(row.type),
    };
    const ok = row.requests - row.failed;
    return [
      ...(ok > 0 ? [{ ...base, status: "ok" as const, count: ok }] : []),
      ...(row.failed > 0
        ? [{ ...base, status: "error" as const, count: row.failed }]
        : []),
    ];
  });
  return { facts, truncated: false };
}

async function mcpFacts(read: FactRead): Promise<FactResult> {
  const rows = await LogFeedModel.toolCallFacts({
    ...read,
    filters: { q: read.q, sessionId: read.sessionId },
  });
  const facts = rows.map(
    (row): LogFact => ({
      source: "mcp",
      hour: row.hour.getTime(),
      status: row.isError ? "error" : "ok",
      count: row.count,
      actor: row.userId
        ? { kind: "user", name: row.userName ?? "Unknown user" }
        : { kind: "system", name: "System" },
      agent: agentOf(row.agentId, row.agentName, row.agentType),
      mcpServer: row.mcpServerName,
    }),
  );
  return { facts, truncated: false };
}

async function auditFacts(read: FactRead): Promise<FactResult> {
  const rows = await LogFeedModel.auditFacts({
    ...read,
    filters: { q: read.q },
  });
  const facts = rows.map((row): LogFact => {
    const event = auditEventOf(row);
    return {
      source: "audit",
      hour: row.hour.getTime(),
      status: event.status,
      count: row.count,
      actor: event.actor,
      audit: event.audit,
    };
  });
  return { facts, truncated: false };
}

async function guardrailFacts(read: FactRead): Promise<FactResult> {
  const events = await pageGuardrails({
    ...read,
    query: searchOnly(read),
    need: SMALL_TYPE_CAP + 1,
  });
  return smallTypeFacts(events, read);
}

async function connectionFacts(read: FactRead): Promise<FactResult> {
  const events = await pageConnections({
    ...read,
    query: searchOnly(read),
    need: SMALL_TYPE_CAP + 1,
  });
  return smallTypeFacts(events, read);
}

/** Events of a small type as facts, each counted once. */
function smallTypeFacts(events: LogEvent[], read: FactRead): FactResult {
  return {
    truncated: events.length > SMALL_TYPE_CAP,
    facts: events.slice(0, SMALL_TYPE_CAP).map(
      (e): LogFact => ({
        source: e.source,
        hour: Math.floor(Date.parse(e.timestamp) / HOUR) * HOUR,
        status: e.status,
        count: 1,
        actor: e.actor,
        client: e.client,
        decision: e.guardrail?.decision,
        connectionAction: e.connection?.action,
        sessionId: e.sessionId,
        // The readers applied the search already; these match any search.
        text: read.q ? read.q.toLowerCase() : "",
      }),
    ),
  };
}

/** Only the search, which the small types' readers apply. */
function searchOnly(read: FactRead): LogStatsQuery {
  return { sources: [], statuses: [], decision: [], hours: 1, q: read.q };
}

function guardrailEventOf(
  row: Awaited<ReturnType<typeof listGuardrailEvents>>["data"][number],
  users: Map<string, { name: string; email: string }>,
): LogEvent {
  const actorOf = (callerId: string | null): LogEvent["actor"] => {
    const user = callerId?.startsWith("user:")
      ? users.get(callerId.slice(5))
      : undefined;
    return user
      ? { kind: "user", name: user.name, email: user.email }
      : { kind: "agent", name: callerId ?? "Unknown caller" };
  };
  if (row.type === "consult") {
    const consult = row.consult;
    return {
      id: consult.id,
      source: "guardrails",
      timestamp: consult.createdAt.toISOString(),
      status: consult.outcome === "answered" ? "ok" : "error",
      title: consult.externalName,
      summary: `${humanize(consult.role)} · ${humanize(consult.outcome)}`,
      actor: actorOf(consult.callerId),
      sessionId: consult.sessionId ?? undefined,
      durationMs: consult.durationMs,
      href: `/consults/logs/${consult.id}`,
      guardrail: {
        decision: "consult",
        policy: humanize(consult.role),
        rule: "",
        tool: consult.externalName,
        reason: humanize(consult.outcome),
      },
    };
  }
  const yell = row.yell;
  return {
    id: yell.id,
    source: "guardrails",
    timestamp: yell.createdAt.toISOString(),
    status: yell.resolvedAt ? "ok" : "warning",
    title: "Yell",
    summary: yell.message,
    actor: actorOf(yell.callerId),
    sessionId: yell.sessionId,
    href: `/consults/logs/yells/${yell.id}`,
    guardrail: {
      decision: "yell",
      policy: "",
      rule: "",
      tool: "",
      reason: yell.message,
    },
  };
}

function connectionEventOf(
  event: Awaited<
    ReturnType<typeof ConnectedClientModel.listEvents>
  >["data"][number],
): LogEvent {
  const gateway = event.mcpGateway?.name ?? event.llmProxy?.name ?? "";
  const action = event.via === "oauthSignIn" ? "authorized" : event.action;
  const where = [event.deviceName, event.platform].filter(Boolean).join(" · ");
  return {
    id: event.id,
    source: "connections",
    timestamp: new Date(event.occurredAt).toISOString(),
    status: "ok",
    title: event.agentName,
    summary: where || undefined,
    actor: { kind: "user", name: event.userName, email: event.userEmail },
    client: event.agentName,
    href: `/connections/logs/${encodeURIComponent(event.id)}`,
    connection: { action, client: event.agentName, gateway },
  };
}

function auditEventOf(row: {
  actorType: string;
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  outcome: string;
  resourceType: string | null;
  resourceName: string | null;
}) {
  const status: LogStatus =
    row.outcome === "success"
      ? "ok"
      : row.outcome === "denied"
        ? "blocked"
        : "error";
  const actor: LogEvent["actor"] = {
    kind:
      row.actorType === "service_account" || row.actorType === "api_key"
        ? "service_account"
        : row.actorType === "system"
          ? "system"
          : "user",
    name: row.actorName ?? row.actorEmail ?? "Unknown",
    email: row.actorEmail ?? undefined,
  };
  return {
    status,
    actor,
    audit: {
      action: actionLabel(row.action),
      category: categoryOf(row.action),
      resourceType: row.resourceType ?? row.action.split(".")[0],
      resourceName: row.resourceName ?? "",
    },
  };
}

const AUDIT_OUTCOME: Partial<Record<string, string[]>> = {
  ok: ["success"],
  error: ["failure"],
  blocked: ["denied"],
};

const ACTOR_TYPES: Partial<Record<string, string[]>> = {
  user: ["user", "sso"],
  service_account: ["service_account", "api_key"],
  system: ["system"],
};

function haystack(e: LogEvent): string {
  return [
    e.title,
    e.summary,
    e.actor.name,
    e.client,
    e.connection?.client,
    e.connection?.gateway,
    e.id,
    e.sessionId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Which requests a Client filter value names, as {@link clientOf} labels
 * them: a coding client family, Archestra's own chat, or a ChatOps channel.
 */
function clientMatch(label: string): ClientMatch {
  const familyIds = CLIENT_FILTER_OPTIONS.flatMap((option) =>
    clientFilterToAgentIds(option.value),
  );
  const family = CLIENT_FILTER_OPTIONS.find((option) => option.label === label);
  if (family) {
    return {
      externalAgentIds: clientFilterToAgentIds(family.value),
      notExternalAgentIds: familyIds,
    };
  }
  const sources = (
    Object.entries(INTERACTION_SOURCE_DISPLAY) as [
      InteractionSource,
      { label: string },
    ][]
  )
    .filter(([source, display]) =>
      label === ARCHESTRA_CHAT
        ? isChatSource(source)
        : source.startsWith("chatops:") && display.label === label,
    )
    .map(([source]) => source);
  return { sources, notExternalAgentIds: familyIds };
}

const ARCHESTRA_CHAT = "Archestra Chat";

function isChatSource(source: string): boolean {
  return source === "chat" || source.startsWith("chat:");
}

/**
 * The app a request came from, as the Client filter names it: a known coding
 * client ("Claude Code"), Archestra's own chat, or a ChatOps channel
 * ("Slack").
 */
function clientOf(
  externalAgentId: string | null,
  source: InteractionSource | null,
): string | undefined {
  const family = clientForExternalAgentIds([externalAgentId]);
  if (family) return family.label;
  if (source && isChatSource(source)) return ARCHESTRA_CHAT;
  if (source?.startsWith("chatops:"))
    return INTERACTION_SOURCE_DISPLAY[source].label;
  return undefined;
}

/** `anthropic:messages` → `anthropic`. */
function providerOf(type: string): SupportedProvider {
  const parsed = SupportedProvidersSchema.safeParse(type.split(":")[0]);
  return parsed.success ? parsed.data : "openai";
}

function agentOf(
  id: string | null | undefined,
  name: string | null | undefined,
  agentType: string | null | undefined,
): LogEvent["agent"] {
  if (!id || !name) return undefined;
  const kind =
    agentType === "mcp_gateway" || agentType === "llm_proxy"
      ? agentType
      : "agent";
  return { id, name, kind };
}

/** `agentRun.bulk_canceled` → "Agent run bulk canceled". */
function actionLabel(action: string): string {
  return humanize(action.replace(".", " "));
}

/** `agentRun.updated` → "Agent run". */
function categoryOf(action: string): string {
  return humanize(action.split(".")[0] ?? action);
}

/** `non_success` → "Non success"; `agentRun` → "Agent run". */
function humanize(value: string): string {
  const words = value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._]/g, " ")
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
