// MSW handlers for the real per-type detail pages (and list endpoints they
// call), derived from the unified feed so a clicked row lands on a detail
// page about that same event. Registered ahead of the base handlers; a
// resolver that returns nothing falls through to them.

import type { archestraApiTypes } from "@archestra/shared";
import {
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_DESKTOP_CLIENT_ID,
  CODEX_CLIENT_ID,
  CURSOR_CLIENT_ID,
} from "@archestra/shared/interactions/client";
import { type HttpHandler, HttpResponse, http } from "msw";
import type { LogActor, LogEvent } from "@/lib/logs/log-events.query";
import { makeInteraction, makeSessionSummary } from "@/mocks/data/interactions";
import { getAllLogEvents } from "@/mocks/log-events";

type SessionSummary =
  archestraApiTypes.GetLlmProxyLogSessionsResponses["200"]["data"][number];
type SessionsPage = archestraApiTypes.GetLlmProxyLogSessionsResponses["200"];
type SummaryRow =
  archestraApiTypes.GetLlmProxyLogSummariesResponses["200"]["data"][number];
type SummariesPage = archestraApiTypes.GetLlmProxyLogSummariesResponses["200"];
type Interaction = archestraApiTypes.GetLlmProxyLogResponses["200"];
type McpToolCall = archestraApiTypes.GetMcpToolCallResponses["200"];
type McpToolCallsPage = archestraApiTypes.GetMcpToolCallsResponses["200"];
type Consult =
  archestraApiTypes.GetOpenappaExternalConsultsResponses["200"]["data"][number];
type ConsultsPage =
  archestraApiTypes.GetOpenappaExternalConsultsResponses["200"];
type ConsultDetail =
  archestraApiTypes.GetOpenappaExternalConsultResponses["200"];
type Yell = archestraApiTypes.GetOpenAppaYellResponses["200"];
type YellsPage = archestraApiTypes.GetOpenAppaYellsResponses["200"];
type AuditLog = archestraApiTypes.GetAuditLogResponses["200"];
type AuditLogsPage = archestraApiTypes.GetAuditLogsResponses["200"];
type ConnectionLogPage =
  archestraApiTypes.GetConnectedClientLogResponses["200"];
/**
 * prototype: the backend records only connected/disconnected (plus `via`).
 * The feed's finer action and the client's version ride along as extra
 * fields so the connection detail page can show them.
 */
type ConnectionEvent = ConnectionLogPage["data"][number] & {
  feedAction?: NonNullable<LogEvent["connection"]>["action"];
  clientVersion?: string;
};
type Adoption = archestraApiTypes.GetAgentAdoptionResponses["200"];
type AdoptionMember = Adoption["members"][number];
type AdoptionUsage = archestraApiTypes.GetAgentAdoptionUsageResponses["200"];
type AgentOption =
  archestraApiTypes.GetAgentOptionsResponses["200"]["data"][number];

export const unifiedLogsDetailHandlers: HttpHandler[] = [
  // ===== LLM session page =====
  http.get("/api/llm-proxy-logs/summaries", ({ request }) => {
    const p = new URL(request.url).searchParams;
    const session = sessionOf(p.get("sessionId"));
    if (!session) return;
    let rows = session.turns.map((turn) => summaryRow(session, turn));
    const startDate = time(p.get("startDate"));
    const endDate = time(p.get("endDate"));
    if (startDate !== null)
      rows = rows.filter((r) => Date.parse(r.createdAt) >= startDate);
    if (endDate !== null)
      rows = rows.filter((r) => Date.parse(r.createdAt) <= endDate);
    const beforeId = p.get("beforeId");
    if (beforeId) {
      const target = rows.find((r) => r.id === beforeId);
      const at = target ? Date.parse(target.createdAt) : Number.NaN;
      rows = rows.filter((r) => Date.parse(r.createdAt) < at);
    }
    const desc = p.get("sortDirection") !== "asc";
    rows.sort(
      (a, b) =>
        (Date.parse(a.createdAt) - Date.parse(b.createdAt)) * (desc ? -1 : 1),
    );
    const limit = Number(p.get("limit") ?? 50);
    const offset = Number(p.get("offset") ?? 0);
    const body: SummariesPage = {
      data: rows.slice(offset, offset + limit),
      pagination: offsetPagination({ total: rows.length, limit, offset }),
    };
    return HttpResponse.json(body);
  }),
  http.get("/api/llm-proxy-logs/sessions", ({ request }) => {
    const p = new URL(request.url).searchParams;
    const session = sessionOf(p.get("sessionId"));
    if (!session) return;
    const body: SessionsPage = {
      data: [sessionSummary(session)],
      pagination: {
        limit: Number(p.get("limit") ?? 1),
        nextCursor: null,
        hasNext: false,
      },
    };
    return HttpResponse.json(body);
  }),
  http.get("/api/llm-proxy-logs/:logId", ({ params }) => {
    const idx = index();
    const turn = idx.turnByLlmId.get(String(params.logId));
    if (!turn) return;
    const session = idx.sessions.get(turn.event.sessionId ?? "");
    if (!session) return;
    return HttpResponse.json(fullInteraction(session, turn));
  }),

  // ===== MCP tool calls =====
  http.get("/api/mcp-tool-calls", ({ request }) => {
    const p = new URL(request.url).searchParams;
    const idx = index();
    const sessionId = p.get("sessionId");
    const agentId = p.get("agentId");
    let events: LogEvent[];
    if (sessionId) {
      const session = idx.sessions.get(sessionId);
      if (!session) return;
      events = session.mcp;
    } else if (agentId && idx.agentIds.has(agentId)) {
      events = idx.mcp.filter((e) => e.agent?.id === agentId);
    } else {
      return;
    }
    let rows = events.map((e) => mcpRecord(e));
    const startDate = time(p.get("startDate"));
    const endDate = time(p.get("endDate"));
    if (startDate !== null)
      rows = rows.filter((r) => Date.parse(r.createdAt) >= startDate);
    if (endDate !== null)
      rows = rows.filter((r) => Date.parse(r.createdAt) <= endDate);
    rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const limit = Number(p.get("limit") ?? 100);
    const body: McpToolCallsPage = {
      data: rows.slice(0, limit),
      pagination: { limit, nextCursor: null, hasNext: rows.length > limit },
    };
    return HttpResponse.json(body);
  }),
  http.get("/api/mcp-tool-calls/:mcpToolCallId", ({ params }) => {
    const event = index().byId.get(String(params.mcpToolCallId));
    if (!event || event.source !== "mcp") return;
    return HttpResponse.json(mcpRecord(event));
  }),

  // Agent names for the MCP page header and excerpt.
  http.get("/api/agents/options", ({ request }) => {
    const p = new URL(request.url).searchParams;
    const ids = p
      .getAll("ids")
      .flatMap((v) => v.split(","))
      .filter(Boolean);
    const idx = index();
    if (ids.length === 0 || !ids.some((id) => idx.agentIds.has(id))) return;
    const data = ids.flatMap((id) => {
      const agent = idx.agentIds.get(id);
      return agent ? [agentOption(agent)] : [];
    });
    return HttpResponse.json({
      data,
      pagination: { limit: data.length, nextCursor: null, hasNext: false },
    } satisfies archestraApiTypes.GetAgentOptionsResponses["200"]);
  }),

  // ===== Guardrails: consults and yells =====
  http.get("/api/openappa/external-consults", ({ request }) => {
    const p = new URL(request.url).searchParams;
    const session = sessionOf(p.get("llmSessionId"));
    if (!session) return;
    const data = session.uses
      .map((use) => consultRecord(session, use))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const body: ConsultsPage = {
      data,
      pagination: {
        limit: Number(p.get("limit") ?? 100),
        nextCursor: null,
        hasNext: false,
      },
    };
    return HttpResponse.json(body);
  }),
  http.get("/api/openappa/external-consults/:id", ({ params }) => {
    const idx = index();
    const use = idx.useByConsultId.get(String(params.id));
    if (!use) return;
    const session = idx.sessions.get(use.consult.sessionId ?? "");
    if (!session) return;
    const body: ConsultDetail = {
      consult: consultRecord(session, use),
      llmSessionId: session.id,
      mcpToolCallId: use.mcp?.id ?? null,
    };
    return HttpResponse.json(body);
  }),
  http.get("/api/openappa/yells", ({ request }) => {
    const p = new URL(request.url).searchParams;
    const session = sessionOf(p.get("llmSessionId"));
    if (!session) return;
    const body: YellsPage = {
      data: session.yells.map((y) => yellRecord(session, y)),
      pagination: {
        limit: Number(p.get("limit") ?? 100),
        nextCursor: null,
        hasNext: false,
      },
    };
    return HttpResponse.json(body);
  }),
  http.get("/api/openappa/yells/:id", ({ params }) => {
    const idx = index();
    const event = idx.byId.get(String(params.id));
    if (!event || event.guardrail?.decision !== "yell") return;
    const session = idx.sessions.get(event.sessionId ?? "");
    if (!session) return;
    const yell = session.yells.find((y) => y.event.id === event.id);
    if (!yell) return;
    return HttpResponse.json(yellRecord(session, yell));
  }),

  // ===== Audit =====
  http.get("/api/audit-logs", ({ request }) => {
    const p = new URL(request.url).searchParams;
    let rows = index().audit.map((e) => auditRecord(e));
    const startDate = time(p.get("startDate"));
    const endDate = time(p.get("endDate"));
    if (startDate !== null)
      rows = rows.filter((r) => Date.parse(r.occurredAt) >= startDate);
    if (endDate !== null)
      rows = rows.filter((r) => Date.parse(r.occurredAt) <= endDate);
    for (const key of [
      "actorId",
      "action",
      "outcome",
      "actorType",
      "resourceType",
      "resourceId",
    ] as const) {
      const value = p.get(key);
      if (value) rows = rows.filter((r) => r[key] === value);
    }
    const limit = Number(p.get("limit") ?? 50);
    const offset = Number(p.get("cursor") ?? 0);
    const body: AuditLogsPage = {
      data: rows.slice(offset, offset + limit),
      pagination: {
        limit,
        nextCursor:
          offset + limit < rows.length ? String(offset + limit) : null,
        hasNext: offset + limit < rows.length,
      },
    };
    return HttpResponse.json(body);
  }),
  http.get("/api/audit-logs/:id", ({ params }) => {
    const event = index().byId.get(String(params.id));
    if (!event || event.source !== "audit") return;
    return HttpResponse.json(auditRecord(event));
  }),

  // ===== Agent connections =====
  http.get("/api/connected-clients/log", ({ request }) => {
    const p = new URL(request.url).searchParams;
    let rows = index().connections.map((e) => connectionRecord(e));
    const startDate = time(p.get("startDate"));
    const endDate = time(p.get("endDate"));
    if (startDate !== null)
      rows = rows.filter((r) => Date.parse(r.occurredAt) >= startDate);
    if (endDate !== null)
      rows = rows.filter((r) => Date.parse(r.occurredAt) <= endDate);
    const action = p.get("action");
    if (action) rows = rows.filter((r) => r.action === action);
    const userId = p.get("userId");
    if (userId) rows = rows.filter((r) => r.userId === userId);
    const limit = Number(p.get("limit") ?? 50);
    const offset = Number(p.get("cursor") ?? 0);
    const body: ConnectionLogPage = {
      data: rows.slice(offset, offset + limit),
      pagination: {
        limit,
        nextCursor:
          offset + limit < rows.length ? String(offset + limit) : null,
        hasNext: offset + limit < rows.length,
      },
    };
    return HttpResponse.json(body);
  }),
  http.get("/api/connected-clients/adoption/usage", ({ request }) => {
    const p = new URL(request.url).searchParams;
    return HttpResponse.json(adoptionUsage(p));
  }),
  http.get("/api/connected-clients/adoption", ({ request }) => {
    const p = new URL(request.url).searchParams;
    return HttpResponse.json(adoption(p));
  }),
];

// ============================================================================
// Session model: the feed's events of one session, joined up
// ============================================================================

/** One tool call an LLM response asked for: its consult, then its MCP call. */
type ToolUse = {
  /** The provider's tool_use id, shared by the request, consult and call. */
  id: string;
  tool: string;
  server: string;
  args: Record<string, unknown>;
  consult: LogEvent;
  mcp?: LogEvent;
  yell?: LogEvent;
  turn: Turn;
};

type Turn = { event: LogEvent; index: number; uses: ToolUse[] };

type Session = {
  id: string;
  /** Ascending. */
  events: LogEvent[];
  turns: Turn[];
  uses: ToolUse[];
  mcp: LogEvent[];
  yells: { event: LogEvent; use?: ToolUse }[];
  first: LogEvent;
};

type Index = {
  byId: Map<string, LogEvent>;
  sessions: Map<string, Session>;
  turnByLlmId: Map<string, Turn>;
  useByConsultId: Map<string, ToolUse>;
  mcp: LogEvent[];
  audit: LogEvent[];
  connections: LogEvent[];
  agentIds: Map<string, NonNullable<LogEvent["agent"]>>;
};

let cachedIndex: { feed: LogEvent[]; index: Index } | null = null;

function index(): Index {
  const feed = getAllLogEvents();
  if (cachedIndex?.feed === feed) return cachedIndex.index;
  const built = buildIndex(feed);
  cachedIndex = { feed, index: built };
  return built;
}

function sessionOf(id: string | null): Session | undefined {
  return id ? index().sessions.get(id) : undefined;
}

function buildIndex(feed: LogEvent[]): Index {
  const byId = new Map<string, LogEvent>();
  const bySession = new Map<string, LogEvent[]>();
  const argsByTool = new Map<string, Record<string, unknown>>();
  const agentIds = new Map<string, NonNullable<LogEvent["agent"]>>();
  for (const e of feed) {
    byId.set(e.id, e);
    if (e.agent) agentIds.set(e.agent.id, e.agent);
    if (e.mcp?.tool && e.mcp.arguments)
      argsByTool.set(e.mcp.tool, e.mcp.arguments);
    if (e.sessionId) {
      const list = bySession.get(e.sessionId) ?? [];
      list.push(e);
      bySession.set(e.sessionId, list);
    }
  }

  const sessions = new Map<string, Session>();
  const turnByLlmId = new Map<string, Turn>();
  const useByConsultId = new Map<string, ToolUse>();
  for (const [id, list] of bySession) {
    const events = [...list].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
    const turns: Turn[] = [];
    const uses: ToolUse[] = [];
    const yells: Session["yells"] = [];
    let turn: Turn | undefined;
    let lastUse: ToolUse | undefined;
    for (const e of events) {
      if (e.source === "llm") {
        turn = { event: e, index: turns.length, uses: [] };
        turns.push(turn);
        turnByLlmId.set(e.id, turn);
      } else if (e.guardrail && e.guardrail.decision !== "yell" && turn) {
        const tool = e.guardrail.tool;
        const use: ToolUse = {
          id: `toolu_${shortHash(`${e.id}:${tool}`)}`,
          tool,
          server: tool.split("__")[0],
          args: argsByTool.get(tool) ?? {},
          consult: e,
          turn,
        };
        turn.uses.push(use);
        uses.push(use);
        useByConsultId.set(e.id, use);
        lastUse = use;
      } else if (e.guardrail?.decision === "yell") {
        const use = lastUse?.tool === e.guardrail.tool ? lastUse : undefined;
        if (use) use.yell = e;
        yells.push({ event: e, use });
      } else if (e.source === "mcp" && e.mcp?.method === "tools/call") {
        if (lastUse && !lastUse.mcp && lastUse.tool === e.mcp.tool) {
          lastUse.mcp = e;
          if (e.mcp.arguments) lastUse.args = e.mcp.arguments;
        }
      }
    }
    if (turns.length === 0) continue;
    sessions.set(id, {
      id,
      events,
      turns,
      uses,
      mcp: events.filter((e) => e.source === "mcp"),
      yells,
      first: turns[0].event,
    });
  }

  return {
    byId,
    sessions,
    turnByLlmId,
    useByConsultId,
    mcp: feed.filter((e) => e.source === "mcp"),
    audit: feed.filter((e) => e.source === "audit"),
    connections: feed.filter((e) => e.source === "connections"),
    agentIds,
  };
}

// ============================================================================
// LLM records
// ============================================================================

function interactionType(e: LogEvent): SummaryRow["type"] {
  switch (e.llm?.provider) {
    case "anthropic":
      return "anthropic:messages";
    case "gemini":
      return "gemini:generateContent";
    default:
      return "openai:chatCompletions";
  }
}

function sessionSummary(session: Session): SessionSummary {
  const turns = session.turns.map((t) => t.event);
  const first = session.first;
  const last = turns[turns.length - 1];
  const sum = (pick: (e: LogEvent) => number) =>
    turns.reduce((n, e) => n + pick(e), 0);
  const metered = first.llm?.billingMode !== "subscription";
  const cost = sum((e) => e.llm?.cost ?? 0);
  const client = clientOf(first.client);
  const actor = first.actor;
  return makeSessionSummary({
    sessionId: session.id,
    sessionSource: client.sessionSource,
    source: client.source,
    sources: [client.source],
    requestCount: turns.length,
    totalInputTokens: sum((e) => e.llm?.inputTokens ?? 0),
    totalOutputTokens: sum((e) => e.llm?.outputTokens ?? 0),
    totalCacheReadTokens: sum((e) => e.llm?.cacheReadTokens ?? 0),
    totalCacheWriteTokens: 0,
    totalCost: cost.toFixed(6),
    totalBilledCost: metered ? cost.toFixed(6) : "0",
    totalSubscriptionCost: metered ? null : cost.toFixed(6),
    totalBaselineCost: cost.toFixed(6),
    totalCacheSavings: null,
    firstRequestTime: first.timestamp,
    lastRequestTime: endOf(last),
    models: [...new Set(turns.flatMap((e) => (e.llm ? [e.llm.model] : [])))],
    profileId: first.agent?.id ?? "px-default",
    profileName: first.agent?.name ?? "Default LLM Proxy",
    profileAgentType: first.agent?.kind ?? "llm_proxy",
    externalAgentIds: client.id ? [client.id] : [],
    externalAgentIdLabels: client.id && first.client ? [first.client] : [],
    authMethods: [
      actor.kind === "service_account" ? "virtual_key" : "oauth_user",
    ],
    authenticatedAppNames: [],
    userNames: actor.kind === "user" ? [actor.name] : [],
    userIds: actor.kind === "user" ? [actorId(actor)] : [],
    virtualKeys: [],
    lastUserMessagePreview: promptOf(session),
    lastInteractionId: last.id,
    lastInteractionType: interactionType(last),
    contentNotStored: false,
    conversationTitle:
      first.client === "Chat" ? (first.sessionTitle ?? null) : null,
    claudeCodeTitle:
      first.client === "Claude Code" ? (first.sessionTitle ?? null) : null,
  });
}

function summaryRow(session: Session, turn: Turn): SummaryRow {
  const e = turn.event;
  const llm = e.llm;
  const client = clientOf(e.client);
  const failed = llm?.errorCode !== undefined;
  return {
    id: e.id,
    profileId: e.agent?.id ?? null,
    externalAgentId: client.id,
    sessionId: session.id,
    model: llm?.model ?? null,
    baselineModel: null,
    billingMode: llm?.billingMode ?? "metered",
    inputTokens: llm?.inputTokens ?? null,
    inputTokensEstimated: false,
    outputTokens: llm?.outputTokens ?? null,
    cacheReadTokens: llm?.cacheReadTokens ?? null,
    cacheWriteTokens: 0,
    cost: llm ? llm.cost.toFixed(6) : null,
    baselineCost: null,
    durationMs: e.durationMs ?? null,
    createdAt: endOf(e),
    providerApiKeyId: null,
    modelPoolId: null,
    attempt: null,
    attemptOutcome: null,
    failureReason: null,
    attributionLabels: null,
    type: interactionType(e),
    externalAgentIdLabel: client.id ? (e.client ?? null) : null,
    requestType: "main",
    source: client.source,
    userMessagePreview: turn.index === 0 ? promptOf(session) : null,
    responseToolNames: failed ? null : turn.uses.map((u) => u.tool),
    responseToolCalls: failed
      ? null
      : turn.uses.map((u) => ({ id: u.id, name: u.tool })),
    responseTextPreview: failed ? null : (assistantText(session, turn) ?? null),
    autoRouted: false,
    failed,
  };
}

/** The full stored request and response, in the provider's own wire shape. */
function fullInteraction(session: Session, turn: Turn): Interaction {
  const e = turn.event;
  const llm = e.llm;
  const model = llm?.model ?? "claude-sonnet-4-5";
  const client = clientOf(e.client);
  const actor = e.actor;
  const base = makeInteraction({
    id: e.id,
    profileId: e.agent?.id ?? "px-default",
    sessionId: session.id,
    sessionSource: client.sessionSource,
    billingMode: llm?.billingMode ?? "metered",
    externalAgentId: client.id,
    userId: actor.kind === "user" ? actorId(actor) : null,
    serviceAccountId: actor.kind === "service_account" ? actorId(actor) : null,
    model,
    durationMs: e.durationMs ?? null,
    inputTokens: llm?.inputTokens ?? null,
    outputTokens: llm?.outputTokens ?? null,
    cacheReadTokens: llm?.cacheReadTokens ?? null,
    cacheWriteTokens: 0,
    cost: llm ? llm.cost.toFixed(6) : null,
    createdAt: endOf(e),
  });
  const history = session.turns.slice(0, turn.index);
  const prompt = promptOf(session);
  const system = systemPrompt(e);
  const failed = llm?.errorCode !== undefined;
  const tools = toolDefs(session);
  const text = assistantText(session, turn);

  if (interactionType(e) === "anthropic:messages") {
    const messages: unknown[] = [{ role: "user", content: prompt }];
    for (const past of history) {
      if (past.event.llm?.errorCode !== undefined) continue;
      messages.push({
        role: "assistant",
        content: anthropicBlocks(assistantText(session, past), past.uses),
      });
      if (past.uses.length > 0) {
        messages.push({
          role: "user",
          content: past.uses.map((u) => ({
            type: "tool_result",
            tool_use_id: u.id,
            content: toolResultText(u),
            ...(u.mcp?.status === "error" || !u.mcp ? { is_error: true } : {}),
          })),
        });
      }
    }
    const response = failed
      ? { error: e.summary ?? "Request failed" }
      : {
          id: `msg_${shortHash(e.id)}`,
          type: "message",
          role: "assistant",
          model,
          content: anthropicBlocks(text, turn.uses),
          stop_reason: turn.uses.length > 0 ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: llm?.inputTokens ?? 0,
            output_tokens: llm?.outputTokens ?? 0,
            cache_read_input_tokens: llm?.cacheReadTokens ?? 0,
            cache_creation_input_tokens: 0,
          },
        };
    return {
      ...base,
      type: "anthropic:messages",
      request: {
        model,
        max_tokens: 8192,
        stream: llm?.stream ?? true,
        system,
        messages,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.schema,
        })),
      },
      response,
    } as unknown as Interaction;
  }

  if (interactionType(e) === "gemini:generateContent") {
    const contents: unknown[] = [{ role: "user", parts: [{ text: prompt }] }];
    for (const past of history) {
      if (past.event.llm?.errorCode !== undefined) continue;
      contents.push({
        role: "model",
        parts: geminiParts(assistantText(session, past), past.uses),
      });
      if (past.uses.length > 0) {
        contents.push({
          role: "user",
          parts: past.uses.map((u) => ({
            functionResponse: {
              id: u.id,
              name: u.tool,
              response: { result: toolResultText(u) },
            },
          })),
        });
      }
    }
    const response = failed
      ? { error: e.summary ?? "Request failed" }
      : {
          candidates: [
            {
              index: 0,
              content: { role: "model", parts: geminiParts(text, turn.uses) },
              finishReason: "STOP",
            },
          ],
          modelVersion: model,
          usageMetadata: {
            promptTokenCount: llm?.inputTokens ?? 0,
            candidatesTokenCount: llm?.outputTokens ?? 0,
            cachedContentTokenCount: llm?.cacheReadTokens ?? 0,
            totalTokenCount: (llm?.inputTokens ?? 0) + (llm?.outputTokens ?? 0),
          },
        };
    return {
      ...base,
      type: "gemini:generateContent",
      request: {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [
          {
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.schema,
            })),
          },
        ],
      },
      response,
    } as unknown as Interaction;
  }

  // OpenAI chat completions.
  const messages: unknown[] = [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];
  for (const past of history) {
    if (past.event.llm?.errorCode !== undefined) continue;
    messages.push(openAiAssistant(assistantText(session, past), past.uses));
    for (const u of past.uses) {
      messages.push({
        role: "tool",
        tool_call_id: u.id,
        content: toolResultText(u),
      });
    }
  }
  const response = failed
    ? { error: e.summary ?? "Request failed" }
    : {
        id: `chatcmpl-${shortHash(e.id)}`,
        object: "chat.completion",
        created: Math.floor(Date.parse(endOf(e)) / 1000),
        model,
        choices: [
          {
            index: 0,
            finish_reason: turn.uses.length > 0 ? "tool_calls" : "stop",
            logprobs: null,
            message: openAiAssistant(text, turn.uses),
          },
        ],
        usage: {
          prompt_tokens: llm?.inputTokens ?? 0,
          completion_tokens: llm?.outputTokens ?? 0,
          total_tokens: (llm?.inputTokens ?? 0) + (llm?.outputTokens ?? 0),
          prompt_tokens_details: { cached_tokens: llm?.cacheReadTokens ?? 0 },
        },
      };
  return {
    ...base,
    type: "openai:chatCompletions",
    request: {
      model,
      stream: llm?.stream ?? true,
      messages,
      tools: tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.schema,
        },
      })),
    },
    response,
  } as unknown as Interaction;
}

function anthropicBlocks(text: string | undefined, uses: ToolUse[]) {
  return [
    ...(text ? [{ type: "text", text }] : []),
    ...uses.map((u) => ({
      type: "tool_use",
      id: u.id,
      name: u.tool,
      input: u.args,
    })),
  ];
}

function geminiParts(text: string | undefined, uses: ToolUse[]) {
  return [
    ...(text ? [{ text }] : []),
    ...uses.map((u) => ({
      functionCall: { id: u.id, name: u.tool, args: u.args },
    })),
  ];
}

function openAiAssistant(text: string | undefined, uses: ToolUse[]) {
  return {
    role: "assistant",
    content: text ?? null,
    ...(uses.length > 0
      ? {
          tool_calls: uses.map((u) => ({
            id: u.id,
            type: "function",
            function: { name: u.tool, arguments: JSON.stringify(u.args) },
          })),
        }
      : {}),
  };
}

/** What the model said alongside (or instead of) its tool calls. */
function assistantText(session: Session, turn: Turn): string | undefined {
  if (turn.uses.length > 0) {
    const names = turn.uses.map((u) => `\`${u.tool}\``).join(" and ");
    return turn.index === 0
      ? `I'll start by checking with ${names}.`
      : `Next I'll use ${names}.`;
  }
  const results = session.uses
    .filter((u) => u.turn.index < turn.index)
    .map((u) =>
      u.mcp?.status === "ok"
        ? `- ${u.tool}: ${u.mcp.mcp?.resultPreview ?? "done"}`
        : u.mcp
          ? `- ${u.tool} failed: ${u.mcp.summary ?? "error"}`
          : `- ${u.tool} was not run: ${u.consult.guardrail?.reason ?? "blocked by policy"}`,
    );
  const prompt = promptOf(session);
  return results.length > 0
    ? `Here's what I found for "${prompt}":\n\n${results.join("\n")}\n\nLet me know if you want me to take the next step.`
    : `Here's a first pass at "${prompt}". I didn't need any tools for this one; tell me if you want more detail on any part.`;
}

function toolResultText(u: ToolUse): string {
  if (u.mcp?.status === "ok") return u.mcp.mcp?.resultPreview ?? "OK";
  if (u.mcp) return u.mcp.summary ?? "Tool call failed";
  return `Blocked by guardrail policy "${u.consult.guardrail?.policy}": ${u.consult.guardrail?.reason}`;
}

function toolDefs(session: Session) {
  const seen = new Map<string, Record<string, unknown>>();
  for (const u of session.uses) if (!seen.has(u.tool)) seen.set(u.tool, u.args);
  return [...seen.entries()].map(([name, args]) => ({
    name,
    description: `${name.split("__")[1]?.replace(/_/g, " ") ?? name} (${name.split("__")[0]} MCP server)`,
    schema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(args).map(([key, value]) => [
          key,
          {
            type: Array.isArray(value)
              ? "array"
              : typeof value === "number"
                ? "number"
                : "string",
          },
        ]),
      ),
      required: Object.keys(args),
    },
  }));
}

function systemPrompt(e: LogEvent): string {
  const name = e.agent?.name ?? "Assistant";
  return `You are ${name}, an internal agent at Acme. Use the tools you are given to answer precisely, cite the systems you looked at, and never take a destructive action without the user's explicit go-ahead.`;
}

function promptOf(session: Session): string {
  const first = session.first;
  return first.llm?.errorCode === undefined && first.summary
    ? first.summary
    : (first.sessionTitle ?? "");
}

// ============================================================================
// MCP records
// ============================================================================

function mcpRecord(e: LogEvent): McpToolCall {
  const idx = index();
  const session = idx.sessions.get(e.sessionId ?? "");
  const use = session?.uses.find((u) => u.mcp?.id === e.id);
  const m = e.mcp;
  const actor = e.actor;
  const client = clientOf(e.client);
  const isCall = m?.method === "tools/call";
  const toolResult = !isCall
    ? {
        isError: false,
        content: [{ type: "text", text: e.summary ?? "OK" }],
      }
    : e.status === "error"
      ? {
          isError: true,
          content: [{ type: "text", text: e.summary ?? "Tool call failed" }],
          error: e.summary ?? "Tool call failed",
        }
      : {
          isError: false,
          content: [
            { type: "text", text: m?.resultPreview ?? e.summary ?? "" },
          ],
        };
  return {
    id: e.id,
    ownerType: "agent",
    agentId: e.agent?.id ?? null,
    appId: null,
    mcpServerName: m?.server ?? "unknown",
    method: m?.method ?? "tools/call",
    toolCall:
      isCall && m?.tool
        ? {
            id: use?.id ?? `toolu_${shortHash(e.id)}`,
            name: m.tool,
            arguments: m.arguments ?? {},
          }
        : null,
    toolResult,
    userId: actor.kind === "user" ? actorId(actor) : null,
    serviceAccountId: actor.kind === "service_account" ? actorId(actor) : null,
    runId: null,
    sessionId: session ? session.id : null,
    llmToolCallId: use?.id ?? null,
    authMethod:
      m?.authMethod === "oauth"
        ? "oauth"
        : m?.authMethod === "service_account"
          ? "service_account_token"
          : m?.authMethod === "shared_credential"
            ? "org_token"
            : "user_token",
    oauthClientId: m?.authMethod === "oauth" ? client.id : null,
    source: e.client === "Chat" ? "chat" : "api",
    credentialClientId: null,
    credentialClientType: "mcp_server",
    credentialActorClientId: null,
    durationMs: e.durationMs ?? null,
    createdAt: endOf(e),
    userName: actor.name,
    appName: null,
  };
}

function agentOption(agent: NonNullable<LogEvent["agent"]>): AgentOption {
  return {
    id: agent.id,
    name: agent.name,
    slug: agent.id,
    agentType: agent.kind,
    icon: null,
    scope: "org",
    authorId: null,
    authorName: null,
    authorEmail: null,
    isPersonalGateway: false,
    runtime: null,
    description: null,
    teams: [],
    users: [],
  };
}

// ============================================================================
// Guardrail records
// ============================================================================

function consultRecord(session: Session, use: ToolUse): Consult {
  const e = use.consult;
  const g = e.guardrail;
  const decision = g?.decision ?? "allow";
  const pending = e.status === "pending";
  const answer =
    decision === "allow"
      ? { allow: true, reason: g?.reason }
      : decision === "deny"
        ? { allow: false, reason: g?.reason, rule: g?.rule }
        : pending
          ? null
          : e.status === "ok"
            ? { allow: true, approved_by: g?.reviewer, reason: g?.reason }
            : { allow: false, rejected_by: g?.reviewer, reason: g?.reason };
  const caller = actorId(e.actor);
  return {
    id: e.id,
    organizationId: ORG_ID,
    sessionId: `${caller}|${session.id}`,
    callerId: caller,
    createdAt: endOf(e),
    startedAt: e.timestamp,
    durationMs: e.durationMs ?? 0,
    role: "authority",
    externalName:
      decision === "review"
        ? "on-call-approval"
        : (g?.policy ?? "policy").toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    backend: decision === "review" ? "hitl" : "module",
    request: {
      artifact: {
        tool: use.tool,
        arguments: use.args,
        requirements: [
          {
            policy: g?.policy,
            rule: g?.rule,
            ...(decision === "allow" ? {} : { reason: g?.reason }),
          },
        ],
      },
      session: { agent: e.agent?.name, client: e.client, user: e.actor.name },
    },
    outcome: pending ? "timeout" : "answered",
    answer,
    rawResponse: answer ? toBase64(JSON.stringify(answer)) : null,
    httpStatus: pending ? null : 200,
    diagnostics: pending
      ? toBase64(`Waiting for an approver: ${g?.reason ?? "approval required"}`)
      : null,
    diagnosticsTruncated: false,
    root: `traj-${shortHash(session.id)}`,
    trajectory: `traj-${shortHash(session.id)}`,
    callId: `call:${use.id}`,
    offerId: null,
    callDigest: null,
  };
}

function yellRecord(session: Session, yell: Session["yells"][number]): Yell {
  const e = yell.event;
  const user = session.first.actor;
  const caller = actorId(user);
  const age = Date.now() - Date.parse(e.timestamp);
  const resolved = age > 6 * 3_600_000;
  return {
    id: e.id,
    organizationId: ORG_ID,
    callerId: caller,
    sessionId: `${caller}|${session.id}`,
    toolCallId: yell.use ? `call:${yell.use.id}` : `call:${shortHash(e.id)}`,
    message: [
      (e.summary ?? "").replace(/^"|"$/g, ""),
      yell.use
        ? `\n\nBlocked call: ${yell.use.tool}\nPolicy: ${yell.use.consult.guardrail?.policy} (${yell.use.consult.guardrail?.rule})\nReason given: ${yell.use.consult.guardrail?.reason}`
        : "",
    ].join(""),
    withTrajectory: true,
    superyell: false,
    kind: "agent",
    count: 1,
    createdAt: e.timestamp,
    reportedAt: e.timestamp,
    reportFailed: false,
    resolvedAt: resolved
      ? new Date(Date.parse(e.timestamp) + 2 * 3_600_000).toISOString()
      : null,
    resolvedBy: resolved ? "user-dana-okafor" : null,
    hasArchive: false,
    caller: {
      id: caller,
      type: user.kind === "service_account" ? "service_account" : "user",
      name: user.name,
      email: user.email ?? null,
    },
    callerApp: e.client ? { id: slug(e.client), name: e.client } : null,
    conversation: null,
    trace: { llmSessionId: session.id, mcpToolCallId: null },
  };
}

// ============================================================================
// Audit records
// ============================================================================

const AUDIT_ACTIONS: Record<
  string,
  { action: AuditLog["action"]; resourceType: string; route: string }
> = {
  "Agent updated": {
    action: "agent.updated",
    resourceType: "agent",
    route: "/api/agents/:id",
  },
  "Tool assigned to agent": {
    action: "agentTool.created",
    resourceType: "agentTool",
    route: "/api/agents/:agentId/tools/:toolId",
  },
  "MCP server installed": {
    action: "mcpServer.created",
    resourceType: "mcpServer",
    route: "/api/mcp_server",
  },
  "MCP server credentials rotated": {
    action: "mcpServer.updated",
    resourceType: "mcpServer",
    route: "/api/mcp_server/:id",
  },
  "Guardrail policy published": {
    action: "guardrailsPolicy.updated",
    resourceType: "guardrailsPolicy",
    route: "/api/openappa/policy",
  },
  "Virtual key created": {
    action: "virtualApiKey.created",
    resourceType: "virtualApiKey",
    route: "/api/virtual-api-keys",
  },
  "Provider API key deleted": {
    action: "llmProviderApiKey.deleted",
    resourceType: "llmProviderApiKey",
    route: "/api/llm-provider-api-keys/:id",
  },
  "Cost limit changed": {
    action: "limit.updated",
    resourceType: "limit",
    route: "/api/limits/:id",
  },
  "User invited": {
    action: "invitation.created",
    resourceType: "invitation",
    route: "/api/auth/organization/invite-member",
  },
  "Role updated": {
    action: "role.updated",
    resourceType: "role",
    route: "/api/roles/:id",
  },
  "Member removed from team": {
    action: "team.updated",
    resourceType: "team",
    route: "/api/teams/:id/members/:userId",
  },
  "Signed in": {
    action: "auth.signed_in",
    resourceType: "auth",
    route: "/api/auth/sign-in",
  },
  "Sign-in failed": {
    action: "auth.signed_in",
    resourceType: "auth",
    route: "/api/auth/sign-in",
  },
  "API key revoked": {
    action: "apiKey.deleted",
    resourceType: "apiKey",
    route: "/api/api-keys/:id",
  },
  "Organization settings updated": {
    action: "organization.updated",
    resourceType: "organization",
    route: "/api/organization",
  },
};

function auditRecord(e: LogEvent): AuditLog {
  const a = e.audit;
  const mapped = AUDIT_ACTIONS[a?.action ?? ""] ?? {
    action: "unknown.updated",
    resourceType: a?.resourceType ?? "unknown",
    route: "/api/unknown",
  };
  const actor = e.actor;
  const resourceId = slug(a?.resourceName ?? e.id);
  const diff = a?.diff;
  const isCreate = a?.httpMethod === "POST";
  const isDelete = a?.httpMethod === "DELETE";
  const isAuth = mapped.resourceType === "auth";
  const before = diff
    ? Object.fromEntries(diff.map((d) => [d.field, d.before]))
    : isDelete
      ? { name: a?.resourceName ?? null, status: "active" }
      : isCreate || isAuth
        ? null
        : {
            name: a?.resourceName ?? null,
            updatedAt: shiftIso(e.timestamp, -86_400_000 * 9),
          };
  const after = diff
    ? Object.fromEntries(diff.map((d) => [d.field, d.after]))
    : isDelete
      ? null
      : isAuth
        ? { method: a?.resourceName ?? null }
        : {
            name: a?.resourceName ?? null,
            ...(isCreate ? {} : { updatedAt: e.timestamp }),
          };
  const status = a?.statusCode ?? 200;
  return {
    id: e.id,
    eventSequence: Number.parseInt(e.id.split("-")[1] ?? "0", 36),
    organizationId: ORG_ID,
    occurredAt: e.timestamp,
    createdAt: e.timestamp,
    actorId: actorId(actor),
    actorType:
      actor.kind === "service_account"
        ? "service_account"
        : isAuth && a?.resourceName?.startsWith("SSO")
          ? "sso"
          : "user",
    actorName: actor.name,
    actorEmail: actor.email ?? null,
    impersonatedBy: null,
    action: mapped.action,
    outcome: status === 401 ? "failure" : status === 403 ? "denied" : "success",
    resourceType: mapped.resourceType,
    resourceId,
    resourceName: a?.resourceName ?? null,
    before,
    after,
    httpMethod: a?.httpMethod ?? null,
    httpPath: mapped.route.replace(/:[A-Za-z]+/g, resourceId),
    httpRoute: mapped.route,
    httpStatus: status,
    requestId: `req_${shortHash(e.id)}`,
    sourceIp: a?.ip ?? null,
    userAgent:
      actor.kind === "service_account"
        ? "archestra-cli/1.5.0"
        : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36",
    impersonatedByEmail: null,
  };
}

// ============================================================================
// Connection records
// ============================================================================

function connectionRecord(e: LogEvent): ConnectionEvent {
  const c = e.connection;
  const client = clientOf(c?.client);
  const gateway = e.agent;
  const disconnected = c?.action === "disconnected";
  const platform = (["macos", "macos", "linux", "windows"] as const)[
    Number.parseInt(shortHash(e.id).slice(0, 2), 16) % 4
  ];
  return {
    id: e.id,
    action: disconnected ? "disconnected" : "connected",
    occurredAt: e.timestamp,
    userId: actorId(e.actor),
    userName: e.actor.name,
    userEmail: e.actor.email ?? "",
    clientId: client.id ?? slug(c?.client ?? "client"),
    agentName: c?.client ?? "Client",
    via:
      c?.action === "authorized" || c?.action === "token_refreshed"
        ? "oauthSignIn"
        : "setup",
    platform,
    deviceName: `${slug(e.actor.name.split(" ")[0])}-${platform === "macos" ? "mbp" : platform === "linux" ? "ws" : "pc"}`,
    mcpGateway:
      gateway && gateway.kind !== "llm_proxy"
        ? { id: gateway.id, name: gateway.name }
        : null,
    llmProxy: { id: "px-default", name: "Default LLM Proxy" },
    includeSkills: c?.client === "Claude Code",
    skillCount: c?.client === "Claude Code" ? 6 : 0,
    disconnectedBy:
      disconnected && e.status === "warning"
        ? { id: "user-priya-raman", name: "Priya Raman" }
        : null,
    feedAction: c?.action,
    clientVersion: c?.clientVersion,
  };
}

function adoption(p: URLSearchParams): Adoption {
  const { since, until, events } = windowEvents(p);
  const users = new Map<string, LogActor>();
  for (const e of getAllLogEvents())
    if (e.actor.kind === "user" && e.actor.email)
      users.set(actorId(e.actor), e.actor);
  const members: AdoptionMember[] = [...users.entries()].map(
    ([userId, user]) => {
      const mine = events.filter((e) => actorId(e.actor) === userId);
      const conns = getAllLogEvents().filter(
        (e) => e.source === "connections" && actorId(e.actor) === userId,
      );
      const agents = new Map<string, AdoptionMember["agents"][number]>();
      for (const c of conns) {
        const name = c.connection?.client ?? "Client";
        if (agents.has(name)) continue;
        const lastGateway = mine.find(
          (e) => e.source === "mcp" && e.client === name,
        );
        const lastLlm = mine.find(
          (e) => e.source === "llm" && e.client === name,
        );
        agents.set(name, {
          clientId: clientOf(name).id,
          name,
          status: lastGateway || lastLlm ? "active" : "inactive",
          setupAt: c.timestamp,
          signedIn: c.connection?.action !== "disconnected",
          viaToken: false,
          lastGatewayCallAt: lastGateway?.timestamp ?? null,
          lastLlmCallAt: lastLlm?.timestamp ?? null,
        });
      }
      const uses = (source: "mcp" | "llm") => {
        const groups = new Map<
          string,
          {
            via: { id: string | null; name: string };
            agent: { clientId: string | null; name: string };
            calls: number;
            lastSeenAt: string;
          }
        >();
        for (const e of mine) {
          if (e.source !== source) continue;
          const key = `${e.agent?.id}|${e.client}`;
          const g = groups.get(key);
          if (g) g.calls += 1;
          else
            groups.set(key, {
              via: {
                id: e.agent?.id ?? null,
                name: e.agent?.name ?? "Unknown",
              },
              agent: {
                clientId: clientOf(e.client).id,
                name: e.client ?? "Unknown",
              },
              calls: 1,
              lastSeenAt: e.timestamp,
            });
        }
        return [...groups.values()];
      };
      const gatewayUses = uses("mcp");
      const llmUses = uses("llm");
      return {
        userId,
        name: user.name,
        email: user.email ?? "",
        status:
          gatewayUses.length + llmUses.length > 0
            ? "active"
            : agents.size > 0
              ? "inactive"
              : "notConnected",
        gatewayLastSeenAt: gatewayUses[0]?.lastSeenAt ?? null,
        llmLastSeenAt: llmUses[0]?.lastSeenAt ?? null,
        agents: [...agents.values()],
        gatewayUses,
        llmUses,
      };
    },
  );
  return { since, until, members };
}

function adoptionUsage(p: URLSearchParams): AdoptionUsage {
  const { since, until, events } = windowEvents(p);
  const days = new Map<
    string,
    { date: string; gatewayCalls: number; llmCalls: number }
  >();
  for (let t = Date.parse(since); t <= Date.parse(until); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    days.set(date, { date, gatewayCalls: 0, llmCalls: 0 });
  }
  for (const e of events) {
    const day = days.get(e.timestamp.slice(0, 10));
    if (!day) continue;
    if (e.source === "mcp") day.gatewayCalls += 1;
    if (e.source === "llm") day.llmCalls += 1;
  }
  return { since, until, days: [...days.values()] };
}

function windowEvents(p: URLSearchParams) {
  const until = p.get("endDate") ?? new Date().toISOString();
  const since =
    p.get("startDate") ??
    new Date(Date.parse(until) - 30 * 86_400_000).toISOString();
  const from = Date.parse(since);
  const to = Date.parse(until);
  const events = getAllLogEvents().filter((e) => {
    const t = Date.parse(e.timestamp);
    return t >= from && t <= to;
  });
  return { since, until, events };
}

// ============================================================================
// Shared helpers
// ============================================================================

const ORG_ID = "org-acme";

const CLIENTS: Record<
  string,
  {
    id: string | null;
    source: SummaryRow["source"] & string;
    sessionSource: string | null;
  }
> = {
  "Claude Code": {
    id: CLAUDE_CODE_CLIENT_ID,
    source: "api",
    sessionSource: "claude_metadata",
  },
  "Claude Desktop": {
    id: CLAUDE_DESKTOP_CLIENT_ID,
    source: "api",
    sessionSource: "claude_metadata",
  },
  Codex: { id: CODEX_CLIENT_ID, source: "api", sessionSource: "codex_session" },
  Cursor: { id: CURSOR_CLIENT_ID, source: "api", sessionSource: null },
  Chat: { id: null, source: "chat", sessionSource: null },
  Slack: { id: null, source: "chatops:slack", sessionSource: null },
  "Open WebUI": { id: "open-webui", source: "api", sessionSource: null },
  n8n: { id: "n8n", source: "api", sessionSource: null },
  "VS Code": { id: "vscode", source: "api", sessionSource: null },
};

function clientOf(name: string | undefined) {
  return (
    (name ? CLIENTS[name] : undefined) ?? {
      id: null,
      source: "api" as const,
      sessionSource: null,
    }
  );
}

function actorId(actor: LogActor): string {
  return `${actor.kind === "service_account" ? "sa" : "user"}-${slug(actor.name)}`;
}

function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** A record is written when it completes. */
function endOf(e: LogEvent): string {
  return shiftIso(e.timestamp, e.durationMs ?? 0);
}

function shiftIso(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function time(value: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function offsetPagination(params: {
  total: number;
  limit: number;
  offset: number;
}): SummariesPage["pagination"] {
  const { total, limit, offset } = params;
  return {
    currentPage: Math.floor(offset / Math.max(1, limit)) + 1,
    limit,
    total,
    totalPages: Math.ceil(total / Math.max(1, limit)),
    hasNext: offset + limit < total,
    hasPrev: offset > 0,
  };
}

function shortHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let h2 = h ^ 0x9e3779b9;
  for (let i = text.length - 1; i >= 0; i--) {
    h2 ^= text.charCodeAt(i);
    h2 = Math.imul(h2, 2246822519);
  }
  return (
    (h >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0")
  );
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
