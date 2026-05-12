import logger from "@/logging";
import AuditLogModel from "@/models/audit-log";
import type { FastifyInstanceWithZod } from "@/server";
import type { AuditAction } from "@/types";
import websocketService from "@/websocket";
import { AUDITABLE_ROUTES } from "./audit-log-registry";

export function registerAuditLogHook(fastify: FastifyInstanceWithZod): void {
  fastify.addHook("preHandler", async (request) => {
    if (shouldSkip(request.method, request.url, request.user)) return;

    const routePattern = request.routeOptions.url;
    const cfg = routePattern ? AUDITABLE_ROUTES[routePattern] : undefined;
    if (!cfg?.fetchById) return;

    const id = extractId(request);
    if (!id) return;

    request.auditPriorState = await cfg
      .fetchById(id, request.organizationId)
      .catch((err) => {
        logger.error({ err }, "audit: fetchById (prior) failed");
        return null;
      });
  });

  // Capture the created resource's id from POST response bodies so the
  // onResponse hook can call fetchById to populate post_state.
  fastify.addHook("onSend", async (request, _reply, payload) => {
    if (request.method !== "POST" || typeof payload !== "string")
      return payload;

    const routePattern = request.routeOptions.url;
    const cfg = routePattern ? AUDITABLE_ROUTES[routePattern] : undefined;
    if (!cfg?.fetchById) return payload;

    try {
      const parsed = JSON.parse(payload) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "id" in parsed &&
        typeof (parsed as { id: unknown }).id === "string"
      ) {
        request.auditResponseBodyId = (parsed as { id: string }).id;
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
    const cfg = routePattern ? AUDITABLE_ROUTES[routePattern] : undefined;
    const action = httpMethodToAction(request.method);
    if (!action) return;

    const id = extractId(request) ?? request.auditResponseBodyId ?? null;

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
      priorState: request.auditPriorState ?? null,
      postState,
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

const AUDIT_DENYLIST_PREFIXES = ["/api/auth/", "/api/health", "/api/ready"];

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

function extractId(request: { params: unknown }): string | null {
  const params = request.params as Record<string, unknown> | undefined;
  const id = params?.id;
  return typeof id === "string" ? id : null;
}

function extractIp(request: {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
}): string | null {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  if (Array.isArray(forwarded)) return forwarded[0] ?? null;
  return request.ip ?? null;
}

async function resolvePostState(params: {
  method: string;
  id: string | null;
  organizationId: string;
  cfg: (typeof AUDITABLE_ROUTES)[string] | undefined;
}): Promise<Record<string, unknown> | null> {
  const { method, id, organizationId, cfg } = params;

  if (method === "DELETE") return null;
  if (!cfg?.fetchById || !id) return null;

  return cfg.fetchById(id, organizationId).catch((err) => {
    logger.error({ err }, "audit: fetchById (post) failed");
    return null;
  });
}
