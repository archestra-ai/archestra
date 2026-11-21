import type {
  LogEvent,
  LogEventsQuery,
  LogEventsResponse,
  LogSource,
} from "@/types/log-events";

/**
 * Filters, pages, and counts the events read for one window, newest first.
 * Each facet counts the events every other filter keeps, so a picker still
 * lists its other values after one is picked. The cursor is the offset into
 * the filtered events.
 */
export function queryFeed(params: {
  events: LogEvent[];
  query: LogEventsQuery;
  from: Date;
  to: Date;
  truncated: boolean;
}): LogEventsResponse {
  const { query, from, to, truncated } = params;
  const events = [...params.events].sort(
    (a, b) =>
      Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
      b.id.localeCompare(a.id),
  );
  const q = query.q?.toLowerCase().trim();
  const match = (e: LogEvent, skip?: string) =>
    (skip === "source" ||
      !query.sources.length ||
      query.sources.includes(e.source)) &&
    (skip === "status" ||
      !query.statuses.length ||
      query.statuses.includes(e.status)) &&
    (!query.sessionId || e.sessionId === query.sessionId) &&
    (skip === "agent" || !query.agent || e.agent?.name === query.agent) &&
    (skip === "actor" || !query.actor || e.actor.name === query.actor) &&
    (skip === "client" || !query.client || e.client === query.client) &&
    (skip === "model" || !query.model || e.llm?.model === query.model) &&
    (skip === "mcpServer" ||
      !query.mcpServer ||
      e.mcp?.server === query.mcpServer) &&
    (skip === "decision" ||
      !query.decision.length ||
      (!!e.guardrail && query.decision.includes(e.guardrail.decision))) &&
    (skip === "connectionAction" ||
      !query.connectionAction ||
      e.connection?.action === query.connectionAction) &&
    (skip === "auditAction" ||
      !query.auditAction ||
      e.audit?.action === query.auditAction) &&
    (skip === "auditCategory" ||
      !query.auditCategory ||
      e.audit?.category === query.auditCategory) &&
    (skip === "resourceType" ||
      !query.resourceType ||
      e.audit?.resourceType === query.resourceType) &&
    (skip === "resourceName" ||
      !query.resourceName ||
      e.audit?.resourceName === query.resourceName) &&
    (skip === "actorKind" ||
      !query.actorKind ||
      e.actor.kind === query.actorKind) &&
    (!q || haystack(e).includes(q));
  const facetOf = (skip: string, pick: (e: LogEvent) => string | undefined) =>
    facet(
      events.filter((e) => match(e, skip)),
      pick,
    );

  const filtered = events.filter((e) => match(e));
  const offset = Math.max(0, Number.parseInt(query.cursor ?? "0", 10) || 0);
  const end = offset + query.limit;

  return {
    data: filtered.slice(offset, end),
    nextCursor: end < filtered.length ? String(end) : null,
    total: filtered.length,
    truncated,
    facets: {
      source: facetOf("source", (e) => e.source),
      status: facetOf("status", (e) => e.status),
      agent: facetOf("agent", (e) => e.agent?.name),
      actor: facetOf("actor", (e) => e.actor.name),
      client: facetOf("client", (e) => e.client),
      model: facetOf("model", (e) => e.llm?.model),
      mcpServer: facetOf("mcpServer", (e) => e.mcp?.server),
      decision: facetOf("decision", (e) => e.guardrail?.decision),
      connectionAction: facetOf(
        "connectionAction",
        (e) => e.connection?.action,
      ),
      auditAction: facetOf("auditAction", (e) => e.audit?.action),
      auditCategory: facetOf("auditCategory", (e) => e.audit?.category),
      resourceType: facetOf("resourceType", (e) => e.audit?.resourceType),
      resourceName: facetOf("resourceName", (e) =>
        e.audit
          ? `${e.audit.resourceType}::${e.audit.resourceName}`
          : undefined,
      ),
      auditCategoryAction: facetOf("auditAction", (e) =>
        e.audit ? `${e.audit.category}::${e.audit.action}` : undefined,
      ),
      actorByKind: facetOf("actor", (e) => `${e.actor.kind}::${e.actor.name}`),
    },
    buckets: buckets(filtered, from.getTime(), to.getTime()),
  };
}

// === Internal helpers

const BUCKETS = 48;

function haystack(e: LogEvent): string {
  return [
    e.title,
    e.summary,
    e.actor.name,
    e.agent?.name,
    e.client,
    e.sessionTitle,
    e.llm?.model,
    e.mcp?.server,
    e.mcp?.tool,
    e.guardrail?.policy,
    e.guardrail?.reason,
    e.guardrail?.tool,
    e.audit?.action,
    e.audit?.resourceName,
    e.connection?.client,
    e.connection?.gateway,
    e.id,
    e.sessionId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function facet(
  events: LogEvent[],
  pick: (e: LogEvent) => string | undefined,
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    const value = pick(e);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function buckets(
  events: LogEvent[],
  from: number,
  to: number,
): LogEventsResponse["buckets"] {
  const size = (to - from) / BUCKETS;
  const out = Array.from({ length: BUCKETS }, (_, i) => ({
    start: new Date(from + i * size).toISOString(),
    end: new Date(from + (i + 1) * size).toISOString(),
    bySource: {
      llm: 0,
      mcp: 0,
      guardrails: 0,
      connections: 0,
      audit: 0,
    } satisfies Record<LogSource, number>,
    errors: 0,
  }));
  for (const e of events) {
    const i = Math.min(
      BUCKETS - 1,
      Math.floor((Date.parse(e.timestamp) - from) / size),
    );
    if (i < 0) continue;
    out[i].bySource[e.source] += 1;
    if (e.status === "error" || e.status === "blocked") out[i].errors += 1;
  }
  return out;
}
