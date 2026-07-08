import type { FastifyRequest } from "fastify";
import logger from "@/logging";
import AuditLogModel from "@/models/audit-log";
import UserTokenModel from "@/models/user-token";
import { reportAuditWriteFailure } from "@/observability/metrics/audit";
import type { FastifyInstanceWithZod } from "@/server";
import type { AuditActorType, AuditEventName, AuditOutcome } from "@/types";
import {
  type AuditableRouteConfig,
  deriveAction,
  resolveAuditableRouteConfig,
} from "./audit-log-registry";

function resolveEffectiveCfg(
  routePattern: string | undefined,
  method?: string,
): AuditableRouteConfig | undefined {
  const resolved = resolveAuditableRouteConfig(routePattern);
  if (!resolved) return undefined;
  // If the config was resolved via walk-up, and the request is a POST,
  // discard it to prevent unregistered child POSTs from inheriting parent create semantics.
  if (resolved.viaWalkUp && method === "POST") return undefined;
  return resolved.cfg;
}

export function registerAuditLogHook(fastify: FastifyInstanceWithZod): void {
  fastify.addHook("preHandler", async (request) => {
    if (shouldSkip(request.method, request.url, request.user)) return;

    // Always stamp event time before the handler executes.
    request.auditOccurredAt = new Date();

    const cfg = getEffectiveCfg(request);
    if (!cfg?.fetchById) return;

    const id = await getAuditedResourceId(request, cfg);
    if (!id) return;

    const routeParams = request.params as Record<string, unknown> | undefined;
    request.auditBefore = sanitizeAuditSnapshot(
      await cfg
        .fetchById(id, request.organizationId, routeParams)
        .catch((err) => {
          logger.error({ err }, "audit: fetchById (prior) failed");
          return null;
        }),
    );
  });

  // Capture the created resource's id from POST response bodies so the
  // onResponse hook can call fetchById to populate `after`.
  fastify.addHook("onSend", async (request, _reply, payload) => {
    if (request.method !== "POST" || typeof payload !== "string")
      return payload;

    const cfg = getEffectiveCfg(request);
    if (!cfg?.fetchById) return payload;

    // Skip oversized payloads (e.g. file upload responses) — the `id` we
    // need lives near the top of typical create responses; large bodies just
    // burn CPU on JSON.parse.
    if (payload.length > AUDIT_ONSEND_MAX_PARSE_BYTES) return payload;

    try {
      const parsed = JSON.parse(payload) as unknown;
      const id = extractCreatedResourceId(parsed);
      if (id) {
        request.auditResponseBodyId = id;
      }
    } catch {
      // payload is not JSON (e.g. streaming response) — skip
    }

    return payload;
  });

  fastify.addHook("onResponse", async (request, reply) => {
    if (shouldSkip(request.method, request.url, request.user)) return;

    // 4xx/5xx mutations are now recorded — outcome column carries the signal.
    const routePattern = request.routeOptions.url;
    const cfg = getEffectiveCfg(request);
    const outcome = deriveOutcome(reply.statusCode);
    const action = resolveActionName(cfg, request.method);

    const id =
      (cfg ? await getAuditedResourceId(request, cfg) : null) ??
      request.auditResponseBodyId ??
      null;

    // A handler may supply the post-state directly (e.g. bulk creates whose
    // result can't be represented by a single fetchById); prefer it.
    const after =
      outcome !== "success"
        ? null
        : request.auditAfter !== undefined
          ? request.auditAfter
          : await resolveAfterState({
              method: request.method,
              id,
              organizationId: request.organizationId,
              cfg,
              routeParams: request.params as
                | Record<string, unknown>
                | undefined,
            });

    const sourceIp = extractIp(request);
    const userAgent =
      (request.headers["user-agent"] as string | undefined) ?? null;
    const httpPath = stripQueryString(request.url).slice(0, 2048);
    const actorType: AuditActorType =
      request.authMethod === "api_key"
        ? "api_key"
        : request.authMethod === "service_account"
          ? "service_account"
          : "user";

    const payload = {
      organizationId: request.organizationId,
      actorId: request.user.id,
      actorType,
      actorName: request.user.name ?? null,
      actorEmail: request.user.email,
      action,
      outcome,
      resourceType: cfg?.resourceType ?? null,
      resourceId: id,
      // auditBefore is stored pre-sanitized by the preHandler hook.
      before: request.auditBefore ?? null,
      after: sanitizeAuditSnapshot(after),
      httpMethod: request.method,
      httpPath,
      httpRoute: routePattern ?? null,
      httpStatus: reply.statusCode,
      requestId: request.id,
      sourceIp,
      userAgent,
      occurredAt: request.auditOccurredAt ?? new Date(),
    };

    void AuditLogModel.create(payload).catch((err) => {
      logger.error({ err }, "audit: failed to write audit log row");
      reportAuditWriteFailure({
        source: "http",
        resourceType: payload.resourceType,
      });
    });
  });
}

// === Internal helpers

/**
 * Resolve the effective audit route config once per request; the audit hooks
 * (preHandler/onSend/onResponse) all need it, so the first caller memoizes it
 * on the request. The wrapper marks "computed" even when the result is
 * undefined (unregistered route).
 */
function getEffectiveCfg(
  request: FastifyRequest,
): AuditableRouteConfig | undefined {
  request.auditEffectiveCfg ??= {
    value: resolveEffectiveCfg(request.routeOptions.url, request.method),
  };
  return request.auditEffectiveCfg.value;
}

/**
 * Resolve the audited resource id once per request (it can hit the database,
 * e.g. `currentUserPersonalToken`); preHandler and onResponse both need it.
 * The wrapper marks "computed" even when the resolved id is null.
 */
async function getAuditedResourceId(
  request: FastifyRequest,
  cfg: AuditableRouteConfig,
): Promise<string | null> {
  if (!request.auditResourceId) {
    request.auditResourceId = {
      value: await resolveAuditedResourceId(request, cfg),
    };
  }
  return request.auditResourceId.value;
}

const AUDIT_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Cap on the response body size we'll JSON.parse just to harvest a created id. */
const AUDIT_ONSEND_MAX_PARSE_BYTES = 64 * 1024;

function deriveOutcome(statusCode: number): AuditOutcome {
  if (statusCode >= 200 && statusCode < 300) return "success";
  if (statusCode === 401 || statusCode === 403) return "denied";
  return "failure";
}

function resolveActionName(
  cfg: AuditableRouteConfig | undefined,
  method: string,
): AuditEventName {
  if (cfg?.action) return cfg.action;
  const byMethod =
    cfg?.actionByMethod?.[method as "POST" | "PUT" | "PATCH" | "DELETE"];
  if (byMethod) return byMethod;
  const derived = deriveAction(cfg?.resourceType ?? null, method);
  if (derived) return derived;
  const unknown = fallbackUnknownAction(method);
  logger.warn(
    {
      method,
      resourceType: cfg?.resourceType ?? null,
      fallbackAction: unknown,
    },
    "audit: no action resolved for mutating route; using fallback. Add an entry to AUDITABLE_ROUTES.",
  );
  return unknown;
}

function fallbackUnknownAction(method: string): AuditEventName {
  switch (method) {
    case "POST":
      return "unknown.created";
    case "PUT":
    case "PATCH":
      return "unknown.updated";
    case "DELETE":
      return "unknown.deleted";
    default:
      return "unknown.created";
  }
}

/**
 * Pull a created resource's id from a typical create-response body. Handles
 * both the bare `{ id }` shape and the `{ data: { id } }` envelope used by
 * some Archestra routes.
 */
function extractCreatedResourceId(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id === "string") return obj.id;
  const data = obj.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const nested = (data as Record<string, unknown>).id;
    if (typeof nested === "string") return nested;
  }
  return null;
}

/**
 * High-volume or non-administrative `/api/*` surfaces excluded from org audit
 * (per product direction: MCP session proxy traffic and chat/browser streams
 * stay out of the org audit log; dedicated surfaces cover them).
 *
 * `exact` entries match the URL precisely; `prefix` entries match any URL that
 * starts with the value.  Use `exact` when a route and its siblings share a
 * common prefix that must NOT be excluded — the canonical example is
 * `/api/chat` (the streaming endpoint) vs `/api/chatops/*` (Slack/Teams
 * admin routes that ARE audited).
 */
type AuditDenylistEntry = { kind: "prefix" | "exact"; value: string };

const AUDIT_DENYLIST: readonly AuditDenylistEntry[] = [
  { kind: "prefix", value: "/api/auth/" },
  { kind: "prefix", value: "/api/health" },
  { kind: "prefix", value: "/api/ready" },
  { kind: "prefix", value: "/api/mcp/" },
  // Exact match: /api/chat is the single long-running chat stream endpoint.
  // Prefix would also silence /api/chatops/* (channel bindings, Slack/Teams
  // config, discovery refresh) which are explicitly registered for audit.
  { kind: "exact", value: "/api/chat" },
  // Prefix match to block high-volume chat surface sub-routes like conversations/messages.
  { kind: "prefix", value: "/api/chat/" },
  { kind: "prefix", value: "/api/browser-stream/" },
  { kind: "prefix", value: "/api/secrets/check-connectivity" },
  { kind: "prefix", value: "/api/members/default-model" },
  // GitHub skill read-only POSTs: discover/preview fetch remote repo data but
  // do not mutate org state — exclude them to avoid false-positive audit noise.
  { kind: "exact", value: "/api/skills/github/discover" },
  { kind: "exact", value: "/api/skills/github/preview" },
  // Read-only embedding connection test: probes the provider but mutates no org
  // state. Auditing it recorded a misleading "Success" outcome on failed probes.
  {
    kind: "exact",
    value: "/api/organization/knowledge-settings/test-embedding",
  },
];

function isDenylisted(url: string): boolean {
  return AUDIT_DENYLIST.some((entry) =>
    entry.kind === "exact" ? url === entry.value : url.startsWith(entry.value),
  );
}

function shouldSkip(method: string, url: string, user: unknown): boolean {
  if (!AUDIT_METHODS.has(method)) return true;
  const path = stripQueryString(url);
  if (!path.startsWith("/api/")) return true;
  if (isDenylisted(path)) return true;
  if (!user) return true;
  return false;
}

async function resolveAuditedResourceId(
  request: {
    params: unknown;
    organizationId?: string;
    user?: { id: string };
  },
  cfg: AuditableRouteConfig,
): Promise<string | null> {
  if (cfg.resourceIdSource === "organizationContext") {
    return request.organizationId ?? null;
  }

  if (cfg.resourceIdSource === "currentUserPersonalToken") {
    if (!request.user?.id || !request.organizationId) return null;
    const token = await UserTokenModel.findByUserAndOrg(
      request.user.id,
      request.organizationId,
    );
    return token?.id ?? null;
  }

  const params = request.params as Record<string, unknown> | undefined;
  if (!params) return null;
  const primary = cfg.resourceIdParam ?? "id";
  const v = params[primary];
  if (typeof v === "string") return v;
  // If the route explicitly names a non-default param (e.g. `agentId`,
  // `roleId`), do NOT silently fall back to `params.id` — nested routes like
  // `/api/agents/:agentId/tools/:id` would otherwise record the *child* id
  // under the parent resource's resourceType.
  if (cfg.resourceIdParam) return null;
  const fallback = params.id;
  return typeof fallback === "string" ? fallback : null;
}

/**
 * Strip the query string from a request URL.
 *
 * The audit log persists `httpPath` in long-lived storage and exposes it via
 * the admin `ilike` search filter, so query parameters must not be recorded:
 * a misconfigured caller may pass secrets such as `?token=…` or `?key=…`,
 * which would otherwise become permanently searchable admin-readable data.
 *
 * Returns the path-only portion. Falls back to a literal `?`-split when the
 * URL constructor cannot parse the input (defensive — `request.url` from
 * Fastify is always a well-formed path-and-query string in practice).
 */
function stripQueryString(url: string): string {
  try {
    return new URL(url, "http://x").pathname;
  } catch {
    const q = url.indexOf("?");
    return q === -1 ? url : url.slice(0, q);
  }
}

/**
 * Resolve the client IP for an audited request.
 *
 * Prefers `request.ip` — Fastify applies the `trustProxy` setting so this
 * already incorporates `x-forwarded-for` when a trusted proxy is configured.
 * Falls back to the first hop in `x-forwarded-for` for environments where
 * `socket.remoteAddress` is unavailable (e.g. Unix-socket listeners) and for
 * setups that have a proxy but haven't configured `ARCHESTRA_TRUST_PROXY`.
 */
function extractIp(request: {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
}): string | null {
  if (request.ip) return request.ip;
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string")
    return forwarded.split(",")[0]?.trim() || null;
  if (Array.isArray(forwarded)) return forwarded[0] ?? null;
  return null;
}

async function resolveAfterState(params: {
  method: string;
  id: string | null;
  organizationId: string;
  cfg: AuditableRouteConfig | undefined;
  routeParams?: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> {
  const { method, id, organizationId, cfg, routeParams } = params;

  if (method === "DELETE") return null;
  if (!cfg?.fetchById || !id) return null;

  return cfg.fetchById(id, organizationId, routeParams).catch((err) => {
    logger.error({ err }, "audit: fetchById (post) failed");
    return null;
  });
}

/** Drop volatile timestamp fields so diffs surface real config changes. */
function sanitizeAuditSnapshot(
  state: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (state === null) return null;
  return deepOmitKeys(state, new Set(["updatedAt"])) as Record<string, unknown>;
}

function deepOmitKeys(value: unknown, keys: Set<string>): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => deepOmitKeys(v, keys));
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (keys.has(k)) continue;
      out[k] = deepOmitKeys(v, keys);
    }
    return out;
  }
  return value;
}
