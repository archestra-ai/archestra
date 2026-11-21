import type { KeysetPosition } from "@/models/log-feed";
import type {
  LogEvent,
  LogEventsPage,
  LogSource,
  LogStats,
  LogStatsQuery,
  LogStatus,
} from "@/types/log-events";

/**
 * A group of events that share every field the Logs page filters and counts
 * by, within one hour. Counts are sums of facts, so a busy hour costs one
 * fact per distinct group, not one per event.
 */
export type LogFact = {
  source: LogSource;
  /** Start of the fact's hour, in ms. */
  hour: number;
  status: LogStatus;
  count: number;
  actor: LogEvent["actor"];
  agent?: { name: string; kind: "agent" | "mcp_gateway" | "llm_proxy" };
  client?: string;
  model?: string;
  provider?: NonNullable<LogEvent["llm"]>["provider"];
  mcpServer?: string;
  decision?: NonNullable<LogEvent["guardrail"]>["decision"];
  connectionAction?: NonNullable<LogEvent["connection"]>["action"];
  audit?: {
    action: string;
    category: string;
    resourceType: string;
    resourceName: string;
  };
  sessionId?: string;
  /**
   * The words a search matches, for a type searched in memory. Absent when
   * the database already applied the search.
   */
  text?: string;
};

/**
 * The total, each filter's values counted as if that filter were off, and
 * hourly buckets, for the facts the query keeps.
 */
export function summarize(params: {
  facts: LogFact[];
  query: LogStatsQuery;
  from: Date;
  to: Date;
  truncated: boolean;
}): LogStats {
  const { facts, query } = params;
  const q = query.q?.toLowerCase().trim();
  const keep = (f: LogFact, skip?: string) =>
    (skip === "source" ||
      !query.sources.length ||
      query.sources.includes(f.source)) &&
    (skip === "status" ||
      !query.statuses.length ||
      query.statuses.includes(f.status)) &&
    (!query.sessionId ||
      f.text === undefined ||
      f.sessionId === query.sessionId) &&
    (skip === "agent" || !query.agent || f.agent?.name === query.agent) &&
    (skip === "actor" || !query.actor || f.actor.name === query.actor) &&
    (skip === "client" || !query.client || f.client === query.client) &&
    (skip === "model" || !query.model || f.model === query.model) &&
    (skip === "mcpServer" ||
      !query.mcpServer ||
      f.mcpServer === query.mcpServer) &&
    (skip === "decision" ||
      !query.decision.length ||
      (!!f.decision && query.decision.includes(f.decision))) &&
    (skip === "connectionAction" ||
      !query.connectionAction ||
      f.connectionAction === query.connectionAction) &&
    (skip === "auditAction" ||
      !query.auditAction ||
      f.audit?.action === query.auditAction) &&
    (skip === "auditCategory" ||
      !query.auditCategory ||
      f.audit?.category === query.auditCategory) &&
    (skip === "resourceType" ||
      !query.resourceType ||
      f.audit?.resourceType === query.resourceType) &&
    (skip === "resourceName" ||
      !query.resourceName ||
      f.audit?.resourceName === query.resourceName) &&
    (skip === "actorKind" ||
      !query.actorKind ||
      f.actor.kind === query.actorKind) &&
    (!q || f.text === undefined || f.text.includes(q));
  const facetOf = (skip: string, pick: (f: LogFact) => string | undefined) =>
    facet(
      facts.filter((f) => keep(f, skip)),
      pick,
    );
  const kept = facts.filter((f) => keep(f));

  return {
    total: kept.reduce((n, f) => n + f.count, 0),
    facets: {
      source: facetOf("source", (f) => f.source),
      status: facetOf("status", (f) => f.status),
      agent: facetOf("agent", (f) => f.agent?.name),
      actor: facetOf("actor", (f) => f.actor.name),
      client: facetOf("client", (f) => f.client),
      model: facetOf("model", (f) => f.model),
      mcpServer: facetOf("mcpServer", (f) => f.mcpServer),
      decision: facetOf("decision", (f) => f.decision),
      connectionAction: facetOf("connectionAction", (f) => f.connectionAction),
      auditAction: facetOf("auditAction", (f) => f.audit?.action),
      auditCategory: facetOf("auditCategory", (f) => f.audit?.category),
      resourceType: facetOf("resourceType", (f) => f.audit?.resourceType),
      resourceName: facetOf("resourceName", (f) =>
        f.audit
          ? `${f.audit.resourceType}::${f.audit.resourceName}`
          : undefined,
      ),
      auditCategoryAction: facetOf("auditAction", (f) =>
        f.audit ? `${f.audit.category}::${f.audit.action}` : undefined,
      ),
      actorByKind: facetOf("actor", (f) => `${f.actor.kind}::${f.actor.name}`),
    },
    buckets: buckets(kept, params.from, params.to),
    directory: directory(facts),
    truncated: params.truncated,
  };
}

/**
 * Each type's position in the timeline: the last row a page showed, or
 * `"end"` once its rows ran out. A type without one starts at the newest.
 */
type FeedCursor = Partial<Record<LogSource, KeysetPosition | "end">>;

function encodeFeedCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** A cursor that does not decode starts from the newest events. */
export function decodeFeedCursor(value: string | undefined): FeedCursor {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    return parsed && typeof parsed === "object" ? (parsed as FeedCursor) : {};
  } catch {
    return {};
  }
}

/**
 * One page from each type's newest rows after its position. Each type read
 * `limit + 1` rows, so a type that returned fewer has no more; a type whose
 * rows the page did not reach keeps its position and is read again.
 */
export function mergePages(params: {
  pages: Partial<Record<LogSource, LogEvent[]>>;
  cursor: FeedCursor;
  limit: number;
}): LogEventsPage {
  const { pages, cursor, limit } = params;
  const merged = (Object.values(pages).flat() as LogEvent[]).sort(newestFirst);
  const data = merged.slice(0, limit);
  if (merged.length <= limit) return { data, nextCursor: null };

  const next: FeedCursor = { ...cursor };
  for (const [source, rows] of Object.entries(pages) as [
    LogSource,
    LogEvent[],
  ][]) {
    const shown = data.filter((e) => e.source === source);
    const last = shown.at(-1);
    if (last) next[source] = { at: last.timestamp, id: last.id };
    if (shown.length === rows.length && rows.length <= limit)
      next[source] = "end";
  }
  return { data, nextCursor: encodeFeedCursor(next) };
}

// === Internal helpers

const HOUR = 3_600_000;

function newestFirst(a: LogEvent, b: LogEvent): number {
  return (
    Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
    (b.id > a.id ? 1 : b.id < a.id ? -1 : 0)
  );
}

function facet(
  facts: LogFact[],
  pick: (f: LogFact) => string | undefined,
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const f of facts) {
    const value = pick(f);
    if (value) counts.set(value, (counts.get(value) ?? 0) + f.count);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** One bucket per clock hour the window touches. */
function buckets(facts: LogFact[], from: Date, to: Date): LogStats["buckets"] {
  const first = Math.floor(from.getTime() / HOUR) * HOUR;
  const count = Math.floor(to.getTime() / HOUR) - first / HOUR + 1;
  const out = Array.from({ length: count }, (_, i) => ({
    start: new Date(first + i * HOUR).toISOString(),
    end: new Date(first + (i + 1) * HOUR).toISOString(),
    bySource: {
      llm: 0,
      mcp: 0,
      guardrails: 0,
      connections: 0,
      audit: 0,
    } satisfies Record<LogSource, number>,
    errors: 0,
  }));
  for (const f of facts) {
    const bucket = out[Math.floor((f.hour - first) / HOUR)];
    if (!bucket) continue;
    bucket.bySource[f.source] += f.count;
    if (f.status === "error" || f.status === "blocked")
      bucket.errors += f.count;
  }
  return out;
}

function directory(facts: LogFact[]): LogStats["directory"] {
  const agents = new Map<string, NonNullable<LogFact["agent"]>["kind"]>();
  const models = new Map<string, NonNullable<LogFact["provider"]>>();
  const emails = new Map<string, string>();
  for (const f of facts) {
    if (f.agent) agents.set(f.agent.name, f.agent.kind);
    if (f.model && f.provider) models.set(f.model, f.provider);
    if (f.actor.email) emails.set(f.actor.name, f.actor.email);
  }
  return {
    agents: [...agents].map(([name, kind]) => ({ name, kind })),
    models: [...models].map(([name, provider]) => ({ name, provider })),
    emails: [...emails].map(([name, email]) => ({ name, email })),
  };
}
