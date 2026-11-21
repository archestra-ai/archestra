// Deterministic, realistic cross-source log feed for the unified Logs page,
// served by MSW at `GET /api/logs/events` and `GET /api/logs/stats`. Sessions are coherent: a user in a
// client app drives an agent; each turn is an LLM request, the tool calls it
// asks for go through a guardrail consult and then the MCP Gateway, and the
// next LLM request carries the results. Audit and connection events are
// interleaved across the same 3-day window, anchored to "now".

import { HttpResponse, http } from "msw";
import type {
  LogActor,
  LogBucket,
  LogEvent,
  LogEventsPage,
  LogFacetCount,
  LogSource,
  LogStats,
  LogStatus,
} from "@/lib/logs/log-events.query";

export const unifiedLogsHandlers = [
  http.get("/api/logs/events", ({ request }) => {
    const { data, nextCursor } = queryFeed(new URL(request.url).searchParams);
    return HttpResponse.json({ data, nextCursor } satisfies LogEventsPage);
  }),
  http.get("/api/logs/stats", ({ request }) => {
    const { total, facets, buckets, inWindow } = queryFeed(
      new URL(request.url).searchParams,
    );
    return HttpResponse.json({
      total,
      facets,
      buckets,
      directory: directoryOf(inWindow),
      truncated: false,
    } satisfies LogStats);
  }),
];

// ===== query =====

function queryFeed(
  p: URLSearchParams,
): LogEventsPage &
  Pick<LogStats, "total" | "facets" | "buckets"> & { inWindow: LogEvent[] } {
  const all = getFeed();
  const hours = Number(p.get("hours") ?? 24);
  const now = Date.now();
  const from = now - hours * 3_600_000;
  const sources = csv(p.get("sources")) as LogSource[];
  const statuses = csv(p.get("statuses")) as LogStatus[];
  const q = p.get("q")?.toLowerCase().trim();
  const eq = (key: string) => p.get(key) ?? undefined;
  const sessionId = eq("sessionId");
  const agent = eq("agent");
  const actor = eq("actor");
  const client = eq("client");
  const model = eq("model");
  const mcpServer = eq("mcpServer");
  const decisions = csv(p.get("decision"));
  const connectionAction = eq("connectionAction");
  const auditAction = eq("auditAction");
  const auditCategory = eq("auditCategory");
  const resourceType = eq("resourceType");
  const resourceName = eq("resourceName");
  const actorKind = eq("actorKind");

  const inWindow = all.filter((e) => {
    const t = Date.parse(e.timestamp);
    return t >= from && t <= now;
  });

  // Facets count everything except their own dimension's filter, the way
  // facet sidebars usually behave.
  const match = (e: LogEvent, skip?: string) =>
    (skip === "source" || !sources.length || sources.includes(e.source)) &&
    (skip === "status" || !statuses.length || statuses.includes(e.status)) &&
    (!sessionId || e.sessionId === sessionId) &&
    (skip === "agent" || !agent || e.agent?.name === agent) &&
    (skip === "actor" || !actor || e.actor.name === actor) &&
    (skip === "client" || !client || e.client === client) &&
    (skip === "model" || !model || e.llm?.model === model) &&
    (skip === "mcpServer" || !mcpServer || e.mcp?.server === mcpServer) &&
    (skip === "decision" ||
      !decisions.length ||
      (!!e.guardrail && decisions.includes(e.guardrail.decision))) &&
    (skip === "connectionAction" ||
      !connectionAction ||
      e.connection?.action === connectionAction) &&
    (skip === "auditAction" ||
      !auditAction ||
      e.audit?.action === auditAction) &&
    (skip === "auditCategory" ||
      !auditCategory ||
      e.audit?.category === auditCategory) &&
    (skip === "resourceType" ||
      !resourceType ||
      e.audit?.resourceType === resourceType) &&
    (skip === "resourceName" ||
      !resourceName ||
      e.audit?.resourceName === resourceName) &&
    (skip === "actorKind" || !actorKind || e.actor.kind === actorKind) &&
    (!q || haystack(e).includes(q));

  const filtered = inWindow.filter((e) => match(e));
  const limit = Math.min(500, Number(p.get("limit") ?? 100));
  const offset = Number(p.get("cursor") ?? 0);
  const page = filtered.slice(offset, offset + limit);

  return {
    data: page,
    nextCursor:
      offset + limit < filtered.length ? String(offset + limit) : null,
    total: filtered.length,
    facets: {
      source: facet(
        inWindow.filter((e) => match(e, "source")),
        (e) => e.source,
      ),
      status: facet(
        inWindow.filter((e) => match(e, "status")),
        (e) => e.status,
      ),
      agent: facet(
        inWindow.filter((e) => match(e, "agent")),
        (e) => e.agent?.name,
      ),
      actor: facet(
        inWindow.filter((e) => match(e, "actor")),
        (e) => e.actor.name,
      ),
      client: facet(
        inWindow.filter((e) => match(e, "client")),
        (e) => e.client,
      ),
      model: facet(
        inWindow.filter((e) => match(e, "model")),
        (e) => e.llm?.model,
      ),
      mcpServer: facet(
        inWindow.filter((e) => match(e, "mcpServer")),
        (e) => e.mcp?.server,
      ),
      decision: facet(
        inWindow.filter((e) => match(e, "decision")),
        (e) => e.guardrail?.decision,
      ),
      connectionAction: facet(
        inWindow.filter((e) => match(e, "connectionAction")),
        (e) => e.connection?.action,
      ),
      auditAction: facet(
        inWindow.filter((e) => match(e, "auditAction")),
        (e) => e.audit?.action,
      ),
      auditCategory: facet(
        inWindow.filter((e) => match(e, "auditCategory")),
        (e) => e.audit?.category,
      ),
      resourceType: facet(
        inWindow.filter((e) => match(e, "resourceType")),
        (e) => e.audit?.resourceType,
      ),
      /** "resourceType::resourceName" pairs, for two-pane resource pickers. */
      resourceName: facet(
        inWindow.filter((e) => match(e, "resourceName")),
        (e) =>
          e.audit
            ? `${e.audit.resourceType}::${e.audit.resourceName}`
            : undefined,
      ),
      /** "auditCategory::auditAction" pairs, for two-pane event pickers. */
      auditCategoryAction: facet(
        inWindow.filter((e) => match(e, "auditAction")),
        (e) => (e.audit ? `${e.audit.category}::${e.audit.action}` : undefined),
      ),
      /** "actorKind::actorName" pairs, for two-pane actor pickers. */
      actorByKind: facet(
        inWindow.filter((e) => match(e, "actor")),
        (e) => `${e.actor.kind}::${e.actor.name}`,
      ),
    },
    buckets: buckets(filtered, from, now),
    inWindow,
  };
}

function directoryOf(events: LogEvent[]): LogStats["directory"] {
  const agents = new Map<string, LogStats["directory"]["agents"][number]>();
  const models = new Map<string, LogStats["directory"]["models"][number]>();
  const emails = new Map<string, string>();
  for (const e of events) {
    if (e.agent)
      agents.set(e.agent.name, { name: e.agent.name, kind: e.agent.kind });
    if (e.llm)
      models.set(e.llm.model, { name: e.llm.model, provider: e.llm.provider });
    if (e.actor.email) emails.set(e.actor.name, e.actor.email);
  }
  return {
    agents: [...agents.values()],
    models: [...models.values()],
    emails: [...emails].map(([name, email]) => ({ name, email })),
  };
}

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
    e.audit?.action,
    e.audit?.resourceName,
    e.id,
    e.sessionId,
    e.guardrail?.reason,
    e.guardrail?.tool,
    e.connection?.client,
    e.connection?.gateway,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function facet(
  events: LogEvent[],
  pick: (e: LogEvent) => string | undefined,
): LogFacetCount[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    const v = pick(e);
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
}

function buckets(events: LogEvent[], from: number, to: number): LogBucket[] {
  const n = 48;
  const size = (to - from) / n;
  const out: LogBucket[] = Array.from({ length: n }, (_, i) => ({
    start: new Date(from + i * size).toISOString(),
    end: new Date(from + (i + 1) * size).toISOString(),
    bySource: { llm: 0, mcp: 0, guardrails: 0, connections: 0, audit: 0 },
    errors: 0,
  }));
  for (const e of events) {
    const i = Math.min(
      n - 1,
      Math.floor((Date.parse(e.timestamp) - from) / size),
    );
    if (i < 0) continue;
    out[i].bySource[e.source] += 1;
    if (e.status === "error" || e.status === "blocked") out[i].errors += 1;
  }
  return out;
}

function csv(v: string | null): string[] {
  return v ? v.split(",").filter(Boolean) : [];
}

// ===== generation =====

let cached: { anchor: number; events: LogEvent[] } | null = null;

function getFeed(): LogEvent[] {
  // Re-anchor every 10 minutes so "2m ago" stays true while the user browses.
  const anchor = Math.floor(Date.now() / 600_000) * 600_000;
  if (!cached || cached.anchor !== anchor) {
    cached = { anchor, events: generate(anchor) };
  }
  return cached.events;
}

const USERS: LogActor[] = [
  { kind: "user", name: "Dana Okafor", email: "dana.okafor@example.com" },
  { kind: "user", name: "Rafael Nunes", email: "rafael.nunes@example.com" },
  { kind: "user", name: "Mei Tanaka", email: "mei.tanaka@example.com" },
  { kind: "user", name: "Priya Raman", email: "priya.raman@example.com" },
  { kind: "user", name: "Tomás Herrera", email: "tomas.herrera@example.com" },
  { kind: "user", name: "Lena Fischer", email: "lena.fischer@example.com" },
  { kind: "user", name: "Kwame Asante", email: "kwame.asante@example.com" },
  { kind: "user", name: "Sofia Marino", email: "sofia.marino@example.com" },
];
const ADMINS = [USERS[0], USERS[3], USERS[5]];
const SERVICE_ACCOUNTS: LogActor[] = [
  { kind: "service_account", name: "ci-release-bot" },
  { kind: "service_account", name: "nightly-triage" },
];

type AgentDef = {
  id: string;
  name: string;
  kind: "agent" | "mcp_gateway" | "llm_proxy";
  servers: string[];
};
const AGENTS: AgentDef[] = [
  {
    id: "ag-support",
    name: "Support Assistant",
    kind: "agent",
    servers: ["zendesk", "confluence", "slack"],
  },
  {
    id: "ag-sre",
    name: "SRE Copilot",
    kind: "agent",
    servers: ["kubernetes", "grafana", "pagerduty", "github"],
  },
  {
    id: "ag-review",
    name: "Code Reviewer",
    kind: "agent",
    servers: ["github", "linear"],
  },
  {
    id: "ag-sales",
    name: "Sales Research",
    kind: "agent",
    servers: ["hubspot", "google-drive", "web-search"],
  },
  {
    id: "gw-eng",
    name: "Engineering Gateway",
    kind: "mcp_gateway",
    servers: ["github", "jira", "postgres", "linear", "kubernetes"],
  },
  {
    id: "gw-data",
    name: "Data Gateway",
    kind: "mcp_gateway",
    servers: ["snowflake", "postgres", "google-drive"],
  },
  {
    id: "px-default",
    name: "Default LLM Proxy",
    kind: "llm_proxy",
    servers: [],
  },
];

const MODELS: {
  model: string;
  provider: "anthropic" | "openai" | "gemini" | "bedrock";
  inPer1k: number;
  outPer1k: number;
}[] = [
  {
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    inPer1k: 0.003,
    outPer1k: 0.015,
  },
  {
    model: "claude-opus-4-1",
    provider: "anthropic",
    inPer1k: 0.015,
    outPer1k: 0.075,
  },
  {
    model: "claude-haiku-4-5",
    provider: "anthropic",
    inPer1k: 0.001,
    outPer1k: 0.005,
  },
  { model: "gpt-5", provider: "openai", inPer1k: 0.00125, outPer1k: 0.01 },
  {
    model: "gpt-5-mini",
    provider: "openai",
    inPer1k: 0.00025,
    outPer1k: 0.002,
  },
  {
    model: "gemini-2.5-pro",
    provider: "gemini",
    inPer1k: 0.00125,
    outPer1k: 0.01,
  },
];

const TOOLS: Record<
  string,
  { tool: string; args: () => Record<string, unknown>; result: string }[]
> = {
  github: [
    {
      tool: "github__search_code",
      args: () => ({ q: "retryWithBackoff repo:acme/payments" }),
      result: "7 matches in 4 files",
    },
    {
      tool: "github__get_pull_request",
      args: () => ({ owner: "acme", repo: "payments", number: 4821 }),
      result: 'PR #4821 "Make webhook retries idempotent" (open, 3 reviewers)',
    },
    {
      tool: "github__create_pull_request_review",
      args: () => ({
        owner: "acme",
        repo: "payments",
        number: 4821,
        event: "COMMENT",
      }),
      result: "Review submitted with 4 comments",
    },
    {
      tool: "github__merge_pull_request",
      args: () => ({
        owner: "acme",
        repo: "payments",
        number: 4817,
        merge_method: "squash",
      }),
      result: "Merged 9f3c2ab",
    },
  ],
  jira: [
    {
      tool: "jira__search_issues",
      args: () => ({ jql: 'project = PAY AND status = "In Progress"' }),
      result: "12 issues",
    },
    {
      tool: "jira__create_issue",
      args: () => ({
        project: "PAY",
        summary: "Retry queue backs up nightly",
        type: "Bug",
      }),
      result: "Created PAY-2291",
    },
  ],
  confluence: [
    {
      tool: "confluence__search_pages",
      args: () => ({ query: "refund policy EU", spaceKey: "SUP", limit: 5 }),
      result: "Found 5 pages in SUP",
    },
    {
      tool: "confluence__get_page",
      args: () => ({ pageId: "884213" }),
      result: '"Refunds: EU & UK" (2,140 words)',
    },
  ],
  zendesk: [
    {
      tool: "zendesk__get_ticket",
      args: () => ({ ticket_id: 120934 }),
      result: 'Ticket #120934: "Charged twice for annual plan"',
    },
    {
      tool: "zendesk__add_internal_note",
      args: () => ({
        ticket_id: 120934,
        body: "Refund issued, see Stripe re_3P…",
      }),
      result: "Note added",
    },
    {
      tool: "zendesk__update_ticket",
      args: () => ({ ticket_id: 120934, status: "solved" }),
      result: "Ticket updated",
    },
  ],
  slack: [
    {
      tool: "slack__post_message",
      args: () => ({
        channel: "#support-escalations",
        text: "Escalating #120934 to billing",
      }),
      result: "Posted ts=1763481200.4419",
    },
    {
      tool: "slack__search_messages",
      args: () => ({ query: "double charge from:@billing" }),
      result: "14 messages",
    },
  ],
  kubernetes: [
    {
      tool: "kubernetes__get_pods",
      args: () => ({
        namespace: "payments",
        labelSelector: "app=webhook-worker",
      }),
      result: "6 pods, 2 in CrashLoopBackOff",
    },
    {
      tool: "kubernetes__get_pod_logs",
      args: () => ({
        namespace: "payments",
        pod: "webhook-worker-7d9f-xk2lp",
        tailLines: 200,
      }),
      result: "200 lines, last: OOMKilled",
    },
    {
      tool: "kubernetes__scale_deployment",
      args: () => ({
        namespace: "payments",
        name: "webhook-worker",
        replicas: 10,
      }),
      result: "Scaled to 10",
    },
    {
      tool: "kubernetes__delete_pod",
      args: () => ({ namespace: "payments", pod: "webhook-worker-7d9f-xk2lp" }),
      result: "Deleted",
    },
  ],
  grafana: [
    {
      tool: "grafana__query_prometheus",
      args: () => ({
        expr: 'sum(rate(http_requests_total{job="webhook",code=~"5.."}[5m]))',
      }),
      result: "Peak 41.2 req/s at 03:12",
    },
  ],
  pagerduty: [
    {
      tool: "pagerduty__list_incidents",
      args: () => ({ statuses: ["triggered", "acknowledged"] }),
      result: "2 open incidents",
    },
    {
      tool: "pagerduty__acknowledge_incident",
      args: () => ({ id: "Q2W8RX1" }),
      result: "Acknowledged",
    },
  ],
  linear: [
    {
      tool: "linear__search_issues",
      args: () => ({ query: "flaky checkout test" }),
      result: "3 issues",
    },
    {
      tool: "linear__create_comment",
      args: () => ({ issueId: "ENG-1182", body: "Repro attached" }),
      result: "Comment created",
    },
  ],
  hubspot: [
    {
      tool: "hubspot__search_companies",
      args: () => ({ query: "logistics 200-500 employees DACH" }),
      result: "38 companies",
    },
    {
      tool: "hubspot__get_contact",
      args: () => ({ email: "procurement@globex.example" }),
      result: "Contact: Head of Procurement",
    },
  ],
  "google-drive": [
    {
      tool: "google-drive__search_files",
      args: () => ({ query: "Q3 pipeline review" }),
      result: "4 files",
    },
    {
      tool: "google-drive__read_file",
      args: () => ({ fileId: "1xZ…9q" }),
      result: "Q3 Pipeline Review.gslides (24 slides)",
    },
  ],
  "web-search": [
    {
      tool: "web-search__search",
      args: () => ({ query: "Globex logistics expansion 2026" }),
      result: "10 results",
    },
  ],
  postgres: [
    {
      tool: "postgres__query",
      args: () => ({
        sql: "SELECT status, count(*) FROM payouts WHERE created_at > now() - interval '1 day' GROUP BY 1",
      }),
      result: "4 rows",
    },
    {
      tool: "postgres__execute",
      args: () => ({
        sql: "UPDATE payouts SET status = 'retry' WHERE id = ANY($1)",
      }),
      result: "UPDATE 38",
    },
  ],
  snowflake: [
    {
      tool: "snowflake__run_query",
      args: () => ({
        warehouse: "ANALYTICS_XS",
        sql: "SELECT region, sum(arr) FROM revenue.arr_by_account GROUP BY 1",
      }),
      result: "6 rows",
    },
  ],
};

/** Risky tools that a guardrail policy may block or route to approval. */
const RISKY: Record<
  string,
  { policy: string; rule: string; decision: "deny" | "review"; reason: string }
> = {
  kubernetes__delete_pod: {
    policy: "Production change control",
    rule: "prod-destructive-k8s",
    decision: "review",
    reason: "Deleting pods in namespace payments needs an on-call approval.",
  },
  kubernetes__scale_deployment: {
    policy: "Production change control",
    rule: "prod-scale",
    decision: "review",
    reason: "Scaling a production deployment above 8 replicas needs approval.",
  },
  github__merge_pull_request: {
    policy: "Code change control",
    rule: "no-agent-merge-main",
    decision: "deny",
    reason: "Agents may not merge into protected branch main.",
  },
  postgres__execute: {
    policy: "Data write protection",
    rule: "no-writes-prod-db",
    decision: "deny",
    reason: "Write statements against the production database are not allowed.",
  },
  slack__post_message: {
    policy: "Untrusted content isolation",
    rule: "tainted-context-egress",
    decision: "deny",
    reason:
      "Session read untrusted ticket content; posting to a shared channel is blocked.",
  },
  zendesk__update_ticket: {
    policy: "Customer data handling",
    rule: "pii-in-args",
    decision: "review",
    reason: "Arguments contain a card number fragment.",
  },
};

const PROMPTS: Record<string, string[]> = {
  "ag-support": [
    "Customer says they were charged twice for the annual plan, ticket 120934",
    "What's our refund policy for EU customers after 30 days?",
    "Draft a reply to ticket 120877 explaining the SSO outage",
  ],
  "ag-sre": [
    "webhook-worker pods are crashlooping in payments, what's going on?",
    "Why did 5xx spike at 03:12 last night?",
    "Ack the PagerDuty incident and scale webhook-worker to 10",
  ],
  "ag-review": [
    "Review PR 4821 for idempotency issues",
    "Is the flaky checkout test tracked anywhere?",
    "Merge 4817 if CI is green",
  ],
  "ag-sales": [
    "Find DACH logistics companies with 200-500 employees",
    "Summarize the Q3 pipeline review deck",
    "Research Globex before tomorrow's call",
  ],
  "gw-eng": [
    "fix the retry backoff in payments/webhooks.ts and open a PR",
    "how many payouts failed in the last day?",
    "mark the stuck payouts for retry",
    "find where retryWithBackoff is used",
  ],
  "gw-data": [
    "ARR by region for the board deck",
    "pull last quarter's churn by plan",
  ],
  "px-default": [
    "Summarize this incident timeline into a postmortem draft",
    "Translate the release notes to German",
    "Write unit tests for parseInvoiceLines",
  ],
};

function generate(anchor: number): LogEvent[] {
  const rand = mulberry32(20261118);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const between = (a: number, b: number) => a + rand() * (b - a);
  const int = (a: number, b: number) => Math.floor(between(a, b + 1));
  const windowMs = 3 * 24 * 3_600_000;
  const events: LogEvent[] = [];
  let seq = 0;
  const id = (prefix: string) =>
    `${prefix}-${(++seq).toString(36).padStart(5, "0")}`;

  // ---- agent sessions ----
  const sessionCount = 140;
  for (let s = 0; s < sessionCount; s++) {
    // Bias sessions toward working hours and toward recent time.
    const age = rand() ** 1.6 * windowMs;
    let t = anchor - age;
    const agent = pick(AGENTS);
    const user = rand() < 0.12 ? pick(SERVICE_ACCOUNTS) : pick(USERS);
    const client =
      agent.kind === "mcp_gateway"
        ? pick(["Claude Code", "Cursor", "Codex"])
        : agent.kind === "llm_proxy"
          ? pick(["Claude Code", "Codex", "Open WebUI", "n8n"])
          : pick(["Archestra Chat", "Slack", "Archestra Chat", "n8n"]);
    const m =
      agent.id === "ag-sales"
        ? MODELS[5]
        : rand() < 0.55
          ? MODELS[0]
          : pick(MODELS);
    const sessionId = `sess-${s.toString(36).padStart(4, "0")}`;
    const prompt = pick(PROMPTS[agent.id]);
    const sessionTitle =
      prompt.length > 64 ? `${prompt.slice(0, 61)}…` : prompt;
    const turns = agent.kind === "llm_proxy" ? int(1, 4) : int(2, 9);
    let ctx = int(2_000, 9_000);
    const subscription = client === "Claude Code" && rand() < 0.5;

    for (let turn = 0; turn < turns; turn++) {
      const isLast = turn === turns - 1;
      const servers = agent.servers;
      const wantsTools = !isLast && servers.length > 0 && rand() < 0.85;
      const toolCount = wantsTools ? int(1, 3) : 0;
      const outTok = wantsTools ? int(80, 600) : int(300, 2_400);
      const cacheRead = turn === 0 ? 0 : Math.floor(ctx * between(0.6, 0.92));
      const llmMs = Math.floor(between(900, 4_000) + outTok * between(6, 14));
      const llmErr = rand() < 0.035;
      const errCode = llmErr ? pick([429, 529, 400, 500]) : undefined;
      const cost =
        (ctx / 1000) * m.inPer1k +
        (outTok / 1000) * m.outPer1k -
        (cacheRead / 1000) * m.inPer1k * 0.9;
      const llmId = id("llm");
      events.push({
        id: llmId,
        source: "llm",
        timestamp: new Date(t).toISOString(),
        status: llmErr ? "error" : "ok",
        title: m.model,
        summary: llmErr
          ? errCode === 429
            ? "429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit"
            : errCode === 529
              ? "529 overloaded_error: Overloaded"
              : errCode === 400
                ? "400 invalid_request_error: prompt is too long: 212,004 tokens > 200,000 maximum"
                : "500 api_error: Internal server error"
          : turn === 0
            ? prompt
            : wantsTools
              ? `Requested ${toolCount} tool call${toolCount > 1 ? "s" : ""}`
              : "Final answer",
        actor: user,
        agent: { id: agent.id, name: agent.name, kind: agent.kind },
        client,
        sessionId,
        sessionTitle,
        durationMs: llmErr ? int(120, 900) : llmMs,
        href: `/llm/logs/${sessionId}`,
        llm: {
          provider: m.provider,
          model: m.model,
          inputTokens: ctx,
          outputTokens: llmErr ? 0 : outTok,
          cacheReadTokens: cacheRead,
          cost: llmErr ? 0 : Math.max(0.0002, cost),
          billingMode: subscription ? "subscription" : "metered",
          stream: client !== "n8n",
          toolCallsRequested: llmErr ? 0 : toolCount,
          errorCode: errCode,
        },
      });
      t += llmErr ? 900 : llmMs;
      if (llmErr && errCode !== 429) break;
      ctx += outTok;

      for (let k = 0; k < toolCount; k++) {
        const server = pick(servers);
        const def = pick(TOOLS[server] ?? TOOLS.github);
        const risky = RISKY[def.tool];
        const args = def.args();
        // Guardrail consult (OpenAPPA) precedes every tool call.
        const blockRoll = rand();
        let decision: "allow" | "deny" | "review" = "allow";
        if (risky && blockRoll < 0.7) decision = risky.decision;
        else if (!risky && blockRoll < 0.015) decision = "deny";
        const consultMs = int(3, 40);
        const reviewer = decision === "review" ? pick(ADMINS).name : undefined;
        const reviewApproved = decision === "review" && rand() < 0.6;
        events.push({
          id: id("gr"),
          source: "guardrails",
          timestamp: new Date(t).toISOString(),
          status:
            decision === "allow"
              ? "ok"
              : decision === "deny"
                ? "blocked"
                : reviewApproved || anchor - t > 3_600_000
                  ? reviewApproved
                    ? "ok"
                    : "blocked"
                  : "pending",
          title:
            decision === "allow"
              ? `Allowed ${def.tool}`
              : decision === "deny"
                ? `Blocked ${def.tool}`
                : reviewApproved
                  ? `Approved ${def.tool}`
                  : anchor - t > 3_600_000
                    ? `Approval rejected: ${def.tool}`
                    : `Awaiting approval: ${def.tool}`,
          summary:
            decision === "allow"
              ? undefined
              : (risky?.reason ??
                "Tool is not on the allow list for this agent."),
          actor: user,
          agent: { id: agent.id, name: agent.name, kind: agent.kind },
          client,
          sessionId,
          sessionTitle,
          durationMs: consultMs,
          href: `/consults/logs/${id("c")}`,
          guardrail: {
            decision,
            policy:
              risky?.policy ??
              (decision === "allow"
                ? "Organization default"
                : "Tool allow list"),
            rule:
              risky?.rule ??
              (decision === "allow" ? "default-allow-read" : "unlisted-tool"),
            tool: def.tool,
            reason:
              decision === "allow"
                ? "Read-only tool, untainted context."
                : (risky?.reason ??
                  "Tool is not on the allow list for this agent."),
            reviewer,
          },
        });
        t += consultMs;
        const executed = decision === "allow" || reviewApproved;
        if (decision === "review") t += int(20_000, 400_000);

        // A blocked agent sometimes yells back about it.
        if (!executed && rand() < 0.25) {
          events.push({
            id: id("gr"),
            source: "guardrails",
            timestamp: new Date(t + 1200).toISOString(),
            status: "warning",
            title: `Yell: ${agent.name} disputes block`,
            summary: `"I need ${def.tool} to finish the user's request; the call targets a staging resource."`,
            actor: { kind: "agent", name: agent.name },
            agent: { id: agent.id, name: agent.name, kind: agent.kind },
            client,
            sessionId,
            sessionTitle,
            href: `/consults/logs/yells/${id("y")}`,
            guardrail: {
              decision: "yell",
              policy: risky?.policy ?? "Tool allow list",
              rule: risky?.rule ?? "unlisted-tool",
              tool: def.tool,
              reason: "Agent asked for the block to be reviewed.",
            },
          });
        }
        if (!executed) continue;

        const mcpErr = rand() < 0.06;
        const mcpMs = int(60, 2_500) + (server === "snowflake" ? 6_000 : 0);
        events.push({
          id: id("mcp"),
          source: "mcp",
          timestamp: new Date(t).toISOString(),
          status: mcpErr ? "error" : "ok",
          title: def.tool,
          summary: mcpErr
            ? pick([
                "403 Forbidden: token lacks scope for this resource",
                "Upstream timed out after 30s",
                "401 Unauthorized: OAuth token expired and refresh failed",
                "Tool returned isError: rate limited by upstream API",
              ])
            : def.result,
          actor: user,
          agent: { id: agent.id, name: agent.name, kind: agent.kind },
          client,
          sessionId,
          sessionTitle,
          durationMs: mcpErr ? int(30_000, 30_400) : mcpMs,
          href: `/mcp/logs/${id("tc")}`,
          mcp: {
            server,
            tool: def.tool,
            method: "tools/call",
            authMethod:
              user.kind === "service_account"
                ? "service_account"
                : pick(["user_token", "oauth", "oauth", "shared_credential"]),
            arguments: args,
            resultPreview: mcpErr ? undefined : def.result,
            errorMessage: mcpErr ? "Tool call failed" : undefined,
          },
        });
        t += mcpMs;
        ctx += int(200, 4_000);
      }
      t += int(400, 3_000);
      // Some sessions pause for a human between turns.
      if (rand() < 0.25) t += int(30_000, 600_000);
    }

    // Gateway sessions open with initialize + tools/list.
    if (agent.kind === "mcp_gateway") {
      const start = anchor - age - 1_500;
      for (const method of ["initialize", "tools/list"] as const) {
        events.push({
          id: id("mcp"),
          source: "mcp",
          timestamp: new Date(
            start + (method === "tools/list" ? 400 : 0),
          ).toISOString(),
          status: "ok",
          title: method,
          summary:
            method === "initialize"
              ? "Session established"
              : `${agent.servers.length * 9} tools listed`,
          actor: user,
          agent: { id: agent.id, name: agent.name, kind: agent.kind },
          client,
          sessionId,
          sessionTitle,
          durationMs: int(40, 300),
          href: `/mcp/logs/${id("tc")}`,
          mcp: { server: agent.servers[0], method, authMethod: "oauth" },
        });
      }
    }
  }

  // ---- agent connections ----
  for (let i = 0; i < 70; i++) {
    const t = anchor - rand() ** 1.3 * windowMs;
    const user = pick(USERS);
    const client = pick([
      "Claude Code",
      "Cursor",
      "Codex",
      "Claude Desktop",
      "VS Code",
      "Open WebUI",
    ]);
    const gateway = pick(AGENTS.filter((a) => a.kind !== "llm_proxy"));
    const action = pick([
      "connected",
      "connected",
      "token_refreshed",
      "token_refreshed",
      "first_seen",
      "authorized",
      "disconnected",
    ] as const);
    const version =
      client === "Claude Code"
        ? `2.1.${int(240, 290)}`
        : client === "Cursor"
          ? `2.${int(0, 2)}.${int(1, 40)}`
          : `${int(0, 1)}.${int(30, 70)}.${int(0, 9)}`;
    events.push({
      id: id("conn"),
      source: "connections",
      timestamp: new Date(t).toISOString(),
      status: action === "disconnected" && rand() < 0.4 ? "warning" : "ok",
      title:
        action === "first_seen"
          ? `${client} seen for the first time`
          : action === "authorized"
            ? `${client} authorized`
            : action === "token_refreshed"
              ? `${client} refreshed its token`
              : action === "disconnected"
                ? `${client} disconnected`
                : `${client} connected`,
      summary: `${user.name} → ${gateway.name}`,
      actor: user,
      agent: { id: gateway.id, name: gateway.name, kind: gateway.kind },
      client,
      href: "/connections/logs",
      connection: {
        action,
        client,
        gateway: gateway.name,
        clientVersion: version,
      },
    });
  }

  // ---- audit ----
  const AUDIT: {
    action: string;
    category: string;
    resourceType: string;
    names: string[];
    method: "POST" | "PUT" | "PATCH" | "DELETE" | "GET";
    diff?: (
      r: () => number,
    ) => { field: string; before: string | null; after: string | null }[];
  }[] = [
    {
      action: "Agent updated",
      category: "Agents",
      resourceType: "agent",
      names: AGENTS.filter((a) => a.kind === "agent").map((a) => a.name),
      method: "PUT",
      diff: () => [
        {
          field: "systemPrompt",
          before: "You are a helpful support agent…",
          after:
            "You are Acme's support agent. Never promise refunds over $500…",
        },
        {
          field: "model",
          before: "claude-sonnet-4-5",
          after: "claude-opus-4-1",
        },
      ],
    },
    {
      action: "Tool assigned to agent",
      category: "Agents",
      resourceType: "agent_tool",
      names: [
        "kubernetes__delete_pod → SRE Copilot",
        "zendesk__update_ticket → Support Assistant",
        "github__merge_pull_request → Code Reviewer",
      ],
      method: "POST",
    },
    {
      action: "MCP server installed",
      category: "MCP",
      resourceType: "mcp_server",
      names: ["pagerduty", "snowflake", "hubspot", "linear"],
      method: "POST",
    },
    {
      action: "MCP server credentials rotated",
      category: "MCP",
      resourceType: "mcp_server",
      names: ["github", "jira", "zendesk"],
      method: "PATCH",
    },
    {
      action: "Guardrail policy published",
      category: "Guardrails",
      resourceType: "openappa_policy",
      names: [
        "Production change control (rev 14)",
        "Data write protection (rev 6)",
        "Untrusted content isolation (rev 3)",
      ],
      method: "POST",
      diff: () => [
        {
          field: "rules",
          before: "12 rules",
          after: "13 rules (+ prod-scale)",
        },
      ],
    },
    {
      action: "Virtual key created",
      category: "LLM",
      resourceType: "virtual_key",
      names: ["vk-ci-release", "vk-sales-team", "vk-n8n-prod"],
      method: "POST",
    },
    {
      action: "Provider API key deleted",
      category: "LLM",
      resourceType: "llm_provider_api_key",
      names: ["OpenAI (legacy org)"],
      method: "DELETE",
    },
    {
      action: "Cost limit changed",
      category: "LLM",
      resourceType: "limit",
      names: ["Team: Sales — $400/mo", "Org default — $50/user/mo"],
      method: "PUT",
      diff: () => [{ field: "limitUsd", before: "300", after: "400" }],
    },
    {
      action: "User invited",
      category: "Users & access",
      resourceType: "invitation",
      names: ["new.hire@example.com", "contractor.ops@example.com"],
      method: "POST",
    },
    {
      action: "Role updated",
      category: "Users & access",
      resourceType: "role",
      names: ["Support Lead", "Platform Admin"],
      method: "PUT",
      diff: () => [
        {
          field: "permissions.mcpServer",
          before: "read",
          after: "read, update",
        },
      ],
    },
    {
      action: "Member removed from team",
      category: "Users & access",
      resourceType: "team_member",
      names: ["Kwame Asante ← Sales"],
      method: "DELETE",
    },
    {
      action: "Signed in",
      category: "Authentication",
      resourceType: "session",
      names: ["SSO (Okta)", "Email + 2FA"],
      method: "POST",
    },
    {
      action: "Sign-in failed",
      category: "Authentication",
      resourceType: "session",
      names: ["Email + password"],
      method: "POST",
    },
    {
      action: "API key revoked",
      category: "Users & access",
      resourceType: "api_key",
      names: ["ak_live_…7f2c"],
      method: "DELETE",
    },
    {
      action: "Organization settings updated",
      category: "Organization",
      resourceType: "organization",
      names: ["Appearance", "Chat defaults"],
      method: "PATCH",
    },
  ];
  for (let i = 0; i < 110; i++) {
    const t = anchor - rand() ** 1.2 * windowMs;
    const def = pick(AUDIT);
    const signIn = def.category === "Authentication";
    const actor = signIn
      ? pick(USERS)
      : rand() < 0.1
        ? SERVICE_ACCOUNTS[0]
        : pick(ADMINS);
    const failed = def.action === "Sign-in failed" || rand() < 0.04;
    const statusCode =
      def.action === "Sign-in failed"
        ? 401
        : failed
          ? 403
          : def.method === "POST"
            ? 201
            : 200;
    events.push({
      id: id("aud"),
      source: "audit",
      timestamp: new Date(t).toISOString(),
      status: failed ? "error" : "ok",
      title: def.action,
      summary: pick(def.names),
      actor,
      href: `/audit/logs?event=${seq}`,
      audit: {
        action: def.action,
        category: def.category,
        resourceType: def.resourceType,
        resourceName: pick(def.names),
        httpMethod: def.method,
        statusCode,
        ip: `10.${int(0, 40)}.${int(0, 255)}.${int(2, 254)}`,
        diff: def.diff?.(rand),
      },
    });
  }

  for (const e of events) e.href = detailHref(e);
  return events
    .filter((e) => Date.parse(e.timestamp) <= anchor)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

/** Each event type's real detail page, the way today's list pages link. */
function detailHref(e: LogEvent): string {
  switch (e.source) {
    case "llm":
      return e.sessionId
        ? `/llm/logs/${e.sessionId}?request=${e.id}`
        : `/llm/logs/${e.id}`;
    case "mcp":
      return `/mcp/logs/${e.id}`;
    case "guardrails":
      return e.guardrail?.decision === "yell"
        ? `/consults/logs/yells/${e.id}`
        : `/consults/logs/${e.id}`;
    case "audit":
      return `/audit/logs/${e.id}`;
    case "connections":
      return `/connections/logs/${e.id}`;
  }
}

/** All generated events (every source, whole 3-day window), newest first. */
export function getAllLogEvents(): LogEvent[] {
  return getFeed();
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
