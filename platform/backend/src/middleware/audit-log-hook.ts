import logger from "@/logging";
import AuditLogModel from "@/models/audit-log";
import UserTokenModel from "@/models/user-token";
import type { FastifyInstanceWithZod } from "@/server";
import type { AuditAction } from "@/types";
import websocketService from "@/websocket";
import {
  type AuditableRouteConfig,
  resolveAuditableRouteConfig,
} from "./audit-log-registry";

export function registerAuditLogHook(fastify: FastifyInstanceWithZod): void {
  fastify.addHook("preHandler", async (request) => {
    if (shouldSkip(request.method, request.url, request.user)) return;

    const routePattern = request.routeOptions.url;
    const cfg = resolveAuditableRouteConfig(routePattern);
    if (!cfg?.fetchById) return;

    const id = await resolveAuditedResourceId(request, cfg);
    if (!id) return;

    request.auditPriorState = sanitizeAuditSnapshot(
      await cfg.fetchById(id, request.organizationId).catch((err) => {
        logger.error({ err }, "audit: fetchById (prior) failed");
        return null;
      }),
    );
  });

  // Capture the created resource's id from POST response bodies so the
  // onResponse hook can call fetchById to populate post_state.
  fastify.addHook("onSend", async (request, _reply, payload) => {
    if (request.method !== "POST" || typeof payload !== "string")
      return payload;

    const routePattern = request.routeOptions.url;
    const cfg = resolveAuditableRouteConfig(routePattern);
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
    if (reply.statusCode >= 400) return;

    const routePattern = request.routeOptions.url;
    const cfg = resolveAuditableRouteConfig(routePattern);
    const action = httpMethodToAction(request.method);
    if (!action) return;

    const id =
      (cfg ? await resolveAuditedResourceId(request, cfg) : null) ??
      request.auditResponseBodyId ??
      null;

    const postState = await resolvePostState({
      method: request.method,
      id,
      organizationId: request.organizationId,
      cfg,
    });

    const ipAddress = extractIp(request);
    const userAgent =
      (request.headers["user-agent"] as string | undefined) ?? null;
    const httpPath = request.url.slice(0, 2048);

    const payload = {
      organizationId: request.organizationId,
      actorUserId: request.user.id,
      actorName: request.user.name ?? null,
      actorEmail: request.user.email,
      action,
      resourceType: cfg?.resourceType ?? null,
      resourceId: id,
      priorState: sanitizeAuditSnapshot(request.auditPriorState ?? null),
      postState: sanitizeAuditSnapshot(postState),
      httpMethod: request.method,
      httpPath,
      httpRoute: routePattern ?? null,
      httpStatus: reply.statusCode,
      ipAddress,
      userAgent,
    };

    void AuditLogModel.create(payload)
      .then((row) => {
        void websocketService.broadcastAuditLog(row as Record<string, unknown>);
      })
      .catch((err) => {
        logger.error({ err }, "audit: failed to write audit log row");
      });
  });
}

// === Internal helpers

const AUDIT_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Cap on the response body size we'll JSON.parse just to harvest a created id. */
const AUDIT_ONSEND_MAX_PARSE_BYTES = 64 * 1024;

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
 */
const AUDIT_DENYLIST_PREFIXES = [
  "/api/auth/",
  "/api/health",
  "/api/ready",
  "/api/mcp/",
  "/api/chat",
  "/api/browser-stream/",
  "/api/secrets/check-connectivity",
];

function shouldSkip(method: string, url: string, user: unknown): boolean {
  if (!AUDIT_METHODS.has(method)) return true;
  if (!url.startsWith("/api/")) return true;
  if (AUDIT_DENYLIST_PREFIXES.some((p) => url.startsWith(p))) return true;
  if (!user) return true;
  return false;
}

function httpMethodToAction(method: string): AuditAction | null {
  switch (method) {
    case "POST":
      return "create";
    case "PUT":
    case "PATCH":
      return "update";
    case "DELETE":
      return "delete";
    default:
      return null;
  }
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

async function resolvePostState(params: {
  method: string;
  id: string | null;
  organizationId: string;
  cfg: AuditableRouteConfig | undefined;
}): Promise<Record<string, unknown> | null> {
  const { method, id, organizationId, cfg } = params;

  if (method === "DELETE") return null;
  if (!cfg?.fetchById || !id) return null;

  return cfg.fetchById(id, organizationId).catch((err) => {
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
