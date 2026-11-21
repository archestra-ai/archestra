import {
  clientForExternalAgentIds,
  INTERACTION_SOURCE_DISPLAY,
  type InteractionSource,
  type SupportedProvider,
  SupportedProvidersSchema,
} from "@archestra/shared";
import { userHasPermission } from "@/auth";
import {
  AuditLogModel,
  ConnectedClientModel,
  LogFeedModel,
  McpToolCallModel,
} from "@/models";
import { listGuardrailEvents } from "@/services/openappa-guardrail-events";
import { ApiError } from "@/types";
import type {
  LogEvent,
  LogEventsQuery,
  LogEventsResponse,
  LogSource,
} from "@/types/log-events";
import { queryFeed } from "./feed";

/**
 * The Logs page's one timeline. Each type is read under its own permission,
 * `read` for the caller's own records and `admin` for everyone's: `log` for
 * LLM Proxy and MCP Gateway, `guardrailsLog`, `clientConnection`, and
 * `auditLog`. A type the caller cannot read is left out; a caller who can
 * read none is refused. Each type contributes at most its newest
 * {@link PER_TYPE_LIMIT} events in the window, through the same scoped readers
 * its own pages use.
 */
export async function listLogEvents(params: {
  organizationId: string;
  userId: string;
  query: LogEventsQuery;
}): Promise<LogEventsResponse> {
  const { organizationId, userId, query } = params;
  const to = new Date();
  const from = new Date(to.getTime() - query.hours * 3_600_000);
  const access = await readAccess({ organizationId, userId });
  const readable = (Object.keys(access) as LogSource[]).filter(
    (source) => access[source] !== "none",
  );
  if (!readable.length) {
    throw new ApiError(
      403,
      "Reading Logs requires log:read, guardrailsLog:read, clientConnection:read, or auditLog:read",
    );
  }

  const window = { organizationId, userId, from, to };
  const pages = await Promise.all(
    readable.map((source) =>
      READERS[source]({ ...window, everyone: access[source] === "admin" }),
    ),
  );
  return queryFeed({
    events: pages.flat(),
    query,
    from,
    to,
    truncated: pages.some((page) => page.length >= PER_TYPE_LIMIT),
  });
}

// === Internal helpers

/** The newest events of each type a request reads. */
const PER_TYPE_LIMIT = 500;

type Access = "none" | "read" | "admin";

type ReadParams = {
  organizationId: string;
  userId: string;
  from: Date;
  to: Date;
  /** Every member's records; otherwise the caller's own. */
  everyone: boolean;
};

const READERS: Record<LogSource, (params: ReadParams) => Promise<LogEvent[]>> =
  {
    llm: readLlm,
    mcp: readMcp,
    guardrails: readGuardrails,
    connections: readConnections,
    audit: readAudit,
  };

async function readAccess(params: {
  organizationId: string;
  userId: string;
}): Promise<Record<LogSource, Access>> {
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
  return { llm: log, mcp: log, guardrails, connections, audit };
}

async function readLlm(params: ReadParams): Promise<LogEvent[]> {
  const rows = await LogFeedModel.findInteractions({
    organizationId: params.organizationId,
    userId: params.everyone ? undefined : params.userId,
    from: params.from,
    to: params.to,
    limit: PER_TYPE_LIMIT,
  });
  return rows.map((row) => ({
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
  }));
}

async function readMcp(params: ReadParams): Promise<LogEvent[]> {
  const { data } = await McpToolCallModel.findAllCursorPaginated(
    { limit: PER_TYPE_LIMIT },
    undefined,
    undefined,
    {
      organizationId: params.organizationId,
      startDate: params.from,
      endDate: params.to,
      ownUserId: params.everyone ? undefined : params.userId,
    },
  );
  const agents = await LogFeedModel.findAgentNames([
    ...new Set(data.flatMap((row) => (row.agentId ? [row.agentId] : []))),
  ]);
  return data.map((row) => {
    const agent = row.agentId ? agents.get(row.agentId) : undefined;
    const args = row.toolCall?.arguments;
    return {
      id: row.id,
      source: "mcp",
      timestamp: row.createdAt.toISOString(),
      status: row.isError ? "error" : "ok",
      title: row.toolName ?? row.method,
      actor: row.userId
        ? { kind: "user", name: row.userName ?? "Unknown user" }
        : { kind: "system", name: "System" },
      agent: agentOf(row.agentId, agent?.name, agent?.agentType),
      sessionId: row.sessionId ?? undefined,
      durationMs: row.durationMs ?? undefined,
      href: `/mcp/logs/${row.id}`,
      mcp: {
        server: row.mcpServerName,
        tool: row.toolName ?? undefined,
        method: row.method,
        authMethod: row.authMethod ?? "unknown",
        arguments: args && typeof args === "object" ? args : undefined,
      },
    } satisfies LogEvent;
  });
}

/** Guardrails scopes consults and yells to the caller itself. */
async function readGuardrails(params: ReadParams): Promise<LogEvent[]> {
  const { data } = await listGuardrailEvents({
    organizationId: params.organizationId,
    userId: params.userId,
    query: {
      type: "all",
      from: params.from,
      to: params.to,
      yellStatus: "all",
    },
    limit: PER_TYPE_LIMIT,
  });
  const callerIds = [
    ...new Set(
      data.flatMap((row) => {
        const callerId =
          row.type === "consult" ? row.consult.callerId : row.yell.callerId;
        return callerId?.startsWith("user:") ? [callerId.slice(5)] : [];
      }),
    ),
  ];
  const users = await LogFeedModel.findUserNames(callerIds);
  const actorOf = (callerId: string | null): LogEvent["actor"] => {
    const user = callerId?.startsWith("user:")
      ? users.get(callerId.slice(5))
      : undefined;
    return user
      ? { kind: "user", name: user.name, email: user.email }
      : { kind: "agent", name: callerId ?? "Unknown caller" };
  };
  return data.map((row): LogEvent => {
    if (row.type === "consult") {
      const consult = row.consult;
      const answered = consult.outcome === "answered";
      return {
        id: consult.id,
        source: "guardrails",
        timestamp: consult.createdAt.toISOString(),
        status: answered ? "ok" : "error",
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
  });
}

async function readConnections(params: ReadParams): Promise<LogEvent[]> {
  const { data } = await ConnectedClientModel.listEvents({
    organizationId: params.organizationId,
    pagination: { limit: PER_TYPE_LIMIT },
    userId: params.everyone ? undefined : params.userId,
    startDate: params.from.toISOString(),
    endDate: params.to.toISOString(),
  });
  return data.map((event): LogEvent => {
    const gateway = event.mcpGateway?.name ?? event.llmProxy?.name ?? "";
    const action = event.via === "oauthSignIn" ? "authorized" : event.action;
    const where = [event.deviceName, event.platform]
      .filter(Boolean)
      .join(" · ");
    return {
      id: event.id,
      source: "connections",
      timestamp: new Date(event.occurredAt).toISOString(),
      status: "ok",
      title: event.agentName,
      summary: where || undefined,
      actor: {
        kind: "user",
        name: event.userName,
        email: event.userEmail,
      },
      client: event.agentName,
      href: `/connections/logs/${encodeURIComponent(event.id)}`,
      connection: { action, client: event.agentName, gateway },
    };
  });
}

async function readAudit(params: ReadParams): Promise<LogEvent[]> {
  const { data } = await AuditLogModel.findCursorPaginated({
    organizationId: params.organizationId,
    limit: PER_TYPE_LIMIT,
    startDate: params.from,
    endDate: params.to,
    actorId: params.everyone ? undefined : params.userId,
  });
  return data.map((row): LogEvent => {
    const resourceType = row.action.split(".")[0] ?? row.action;
    return {
      id: row.id,
      source: "audit",
      timestamp: new Date(row.occurredAt).toISOString(),
      status:
        row.outcome === "success"
          ? "ok"
          : row.outcome === "denied"
            ? "blocked"
            : "error",
      title: actionLabel(row.action),
      summary: row.resourceName ?? undefined,
      actor: {
        kind:
          row.actorType === "service_account" || row.actorType === "api_key"
            ? "service_account"
            : row.actorType === "system"
              ? "system"
              : "user",
        name: row.actorName ?? row.actorEmail ?? "Unknown",
        email: row.actorEmail ?? undefined,
      },
      href: `/audit/logs/${row.id}`,
      audit: {
        action: actionLabel(row.action),
        category: humanize(resourceType),
        resourceType: row.resourceType ?? resourceType,
        resourceName: row.resourceName ?? "",
        httpMethod: row.httpMethod ?? "",
        statusCode: row.httpStatus ?? 0,
        ip: row.sourceIp ?? "",
      },
    };
  });
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
  if (source === "chat" || source?.startsWith("chat:")) return "Archestra Chat";
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

/** `non_success` → "Non success"; `agentRun` → "Agent run". */
function humanize(value: string): string {
  const words = value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._]/g, " ")
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
