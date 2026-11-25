// One normalized event shape for every log type the Logs page shows (LLM
// Proxy, MCP Gateway, Guardrails, Client connections, Audit), read from
// `GET /api/logs/events` (in mock mode, `src/mocks/log-events.ts`). Each type
// follows its own permission, `read` for the caller's records and `admin` for
// everyone's: `log` (LLM Proxy, MCP Gateway), `guardrailsLog`,
// `clientConnection`, `auditLog`.

import type { SupportedProvider } from "@archestra/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

export type LogSource = "llm" | "mcp" | "guardrails" | "connections" | "audit";
export type LogStatus = "ok" | "error" | "blocked" | "pending" | "warning";
export type ActorKind = "user" | "agent" | "service_account" | "system";

export const SOURCES: {
  id: LogSource;
  label: string;
  /** Tailwind classes for a small source dot / chip, light + dark safe. */
  dot: string;
  chip: string;
}[] = [
  {
    id: "llm",
    label: "LLM Proxy",
    dot: "bg-violet-500",
    chip: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  {
    id: "mcp",
    label: "MCP Gateway",
    dot: "bg-sky-500",
    chip: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  {
    id: "guardrails",
    label: "Guardrails",
    dot: "bg-amber-500",
    chip: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  {
    id: "connections",
    label: "Client connections",
    dot: "bg-emerald-500",
    chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  {
    id: "audit",
    label: "Audit",
    dot: "bg-slate-500",
    chip: "bg-slate-500/10 text-slate-700 dark:text-slate-300",
  },
];

export const SOURCE_BY_ID = Object.fromEntries(
  SOURCES.map((s) => [s.id, s]),
) as Record<LogSource, (typeof SOURCES)[number]>;

export const STATUS_LABEL: Record<LogStatus, string> = {
  ok: "OK",
  error: "Error",
  blocked: "Blocked",
  pending: "Needs approval",
  warning: "Warning",
};

export interface LogActor {
  kind: ActorKind;
  name: string;
  email?: string;
}

export interface LogEvent {
  id: string;
  source: LogSource;
  /** ISO timestamp. */
  timestamp: string;
  status: LogStatus;
  /** Short headline, e.g. the model, the tool, the audit action. */
  title: string;
  /** One-line preview: last user message, error, guardrail reason, diff. */
  summary?: string;
  actor: LogActor;
  agent?: {
    id: string;
    name: string;
    kind: "agent" | "mcp_gateway" | "llm_proxy";
  };
  /** Client app the traffic came from (Claude Code, Cursor, Slack, ...). */
  client?: string;
  /** Shared by every event of one agent session: LLM, tool call, guardrail. */
  sessionId?: string;
  sessionTitle?: string;
  durationMs?: number;
  /** Where the existing per-source detail page lives. */
  href: string;

  llm?: {
    provider: SupportedProvider;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    /** USD list price. */
    cost: number;
    billingMode: "metered" | "subscription";
    stream: boolean;
    toolCallsRequested: number;
    errorCode?: number;
  };
  mcp?: {
    server: string;
    tool?: string;
    method: "tools/call" | "tools/list" | "initialize" | "resources/read";
    authMethod:
      | "user_token"
      | "oauth"
      | "service_account"
      | "shared_credential";
    arguments?: Record<string, unknown>;
    resultPreview?: string;
    errorMessage?: string;
  };
  guardrail?: {
    /** A consult of an external service, a yell, or (mock data) a decision. */
    decision: GuardrailDecision;
    policy: string;
    rule: string;
    tool: string;
    reason: string;
    reviewer?: string;
  };
  connection?: {
    action:
      | "connected"
      | "first_seen"
      | "authorized"
      | "token_refreshed"
      | "disconnected";
    client: string;
    gateway: string;
    clientVersion?: string;
  };
  audit?: {
    action: string;
    category: string;
    resourceType: string;
    resourceName: string;
    httpMethod: "POST" | "PUT" | "PATCH" | "DELETE" | "GET";
    statusCode: number;
    ip: string;
    diff?: { field: string; before: string | null; after: string | null }[];
  };
}

export type GuardrailDecision =
  | "allow"
  | "deny"
  | "review"
  | "consult"
  | "yell";

export interface LogFacetCount {
  value: string;
  count: number;
}

export interface LogBucket {
  start: string;
  end: string;
  bySource: Record<LogSource, number>;
  errors: number;
}

/** One page of the timeline, newest first. */
export interface LogEventsPage {
  data: LogEvent[];
  nextCursor: string | null;
}

/** Counts for the events a query matches, from `GET /api/logs/stats`. */
export interface LogStats {
  total: number;
  facets: {
    source: LogFacetCount[];
    status: LogFacetCount[];
    agent: LogFacetCount[];
    actor: LogFacetCount[];
    client: LogFacetCount[];
    model: LogFacetCount[];
    mcpServer: LogFacetCount[];
    /** Guardrails: consult | allow | deny | review | yell. */
    decision: LogFacetCount[];
    /** Client connections: connected | first_seen | authorized | token_refreshed | disconnected. */
    connectionAction: LogFacetCount[];
    /** Audit: the action label, e.g. "Agent updated". */
    auditAction: LogFacetCount[];
    /** Audit: the action's category, e.g. "Agent". */
    auditCategory: LogFacetCount[];
    /** Audit: resource type, e.g. "agent", "mcp_server". */
    resourceType: LogFacetCount[];
    /** "resourceType::resourceName" pairs (audit). */
    resourceName: LogFacetCount[];
    /** "auditCategory::auditAction" pairs (audit). */
    auditCategoryAction: LogFacetCount[];
    /** "actorKind::actorName" pairs (user | agent | service_account | system). */
    actorByKind: LogFacetCount[];
  };
  /** One bucket per clock hour of the window, for histograms. */
  buckets: LogBucket[];
  /** What the facets name: each agent's kind, model's maker, person's email. */
  directory: {
    agents: { name: string; kind: "agent" | "mcp_gateway" | "llm_proxy" }[];
    models: { name: string; provider: SupportedProvider }[];
    emails: { name: string; email: string }[];
  };
  /** A small type had more events in the window than one count reads. */
  truncated: boolean;
}

export interface LogEventsQuery {
  sources?: LogSource[];
  statuses?: LogStatus[];
  /** Models, people, agents, clients, servers, tools, actions, resources, or an exact session id. */
  q?: string;
  sessionId?: string;
  agent?: string;
  actor?: string;
  client?: string;
  model?: string;
  mcpServer?: string;
  decision?: GuardrailDecision[];
  connectionAction?: string;
  auditAction?: string;
  auditCategory?: string;
  resourceType?: string;
  resourceName?: string;
  actorKind?: string;
  /** Window size back from now, in hours. Default 24. */
  hours?: number;
  limit?: number;
  cursor?: string | null;
}

/** One page of the timeline. */
export function useLogEvents(query: LogEventsQuery = {}) {
  return useQuery({
    queryKey: ["log-events", query],
    queryFn: async (): Promise<LogEventsPage> => {
      const params = searchParams(query);
      params.set("limit", String(query.limit ?? 50));
      if (query.cursor) params.set("cursor", query.cursor);
      const res = await fetch(`/api/logs/events?${params}`);
      if (!res.ok) throw new Error(`logs feed ${res.status}`);
      return res.json();
    },
    placeholderData: keepPreviousData,
  });
}

/** Counts, filter values and hourly buckets for a query. */
export function useLogStats(query: LogEventsQuery = {}) {
  const { cursor: _cursor, limit: _limit, ...rest } = query;
  return useQuery({
    queryKey: ["log-stats", rest],
    queryFn: async (): Promise<LogStats> => {
      const res = await fetch(`/api/logs/stats?${searchParams(rest)}`);
      if (!res.ok) throw new Error(`logs stats ${res.status}`);
      return res.json();
    },
    placeholderData: keepPreviousData,
  });
}

function searchParams(query: LogEventsQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.sources?.length) params.set("sources", query.sources.join(","));
  if (query.decision?.length) params.set("decision", query.decision.join(","));
  if (query.statuses?.length) params.set("statuses", query.statuses.join(","));
  for (const key of [
    "q",
    "sessionId",
    "agent",
    "actor",
    "client",
    "model",
    "mcpServer",
    "connectionAction",
    "auditAction",
    "auditCategory",
    "resourceType",
    "resourceName",
    "actorKind",
  ] as const) {
    const value = query[key];
    if (value) params.set(key, value);
  }
  params.set("hours", String(query.hours ?? 24));
  return params;
}

// ===== small shared formatters (variants may use or ignore) =====

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatDuration(ms?: number): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function formatRelative(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
