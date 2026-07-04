import { vi } from "vitest";

/**
 * Contract: registerAuditLogHook
 * - Every mutating /api/* request writes an audit row regardless of status code.
 * - outcome: 2xx→success, 401/403→denied, other 4xx/5xx→failure.
 * - action: cfg.action > cfg.actionByMethod > deriveAction > unknown.* fallback.
 * - actor_type comes from request.authMethod (defaults to "user").
 * - request_id = Fastify's request.id.
 * - occurred_at stamped in preHandler, before handler executes.
 * - before captured in preHandler (null for non-success after), after null for
 *   non-success or DELETE; fetched for success POST/PUT/PATCH.
 * - Denylist, method filter, and unauthenticated requests produce no rows.
 * - fetchById / create failures log and never break the response.
 */

const KNOWN_RESOURCE_ID = vi.hoisted(
  () => "00000000-0000-0000-0000-000000000001",
);

vi.mock("@/logging");

vi.mock("./audit-log-registry", async () => {
  const { AuditEventNameSchema } =
    await vi.importActual<typeof import("@/types/audit-log")>(
      "@/types/audit-log",
    );

  const ROUTES: Record<
    string,
    import("./audit-log-registry").AuditableRouteConfig
  > = {
    // Standard CRUD routes with explicit action overrides for predictability.
    "/api/things": {
      resourceType: "agent",
      action: "agent.created",
      fetchById: async (id: string) =>
        id === KNOWN_RESOURCE_ID ? { id, name: "Existing Thing" } : null,
    },
    "/api/things/:id": {
      resourceType: "agent",
      actionByMethod: {
        PATCH: "agent.updated",
        DELETE: "agent.deleted",
      },
      fetchById: async (id: string) =>
        id === KNOWN_RESOURCE_ID ? { id, name: "Existing Thing" } : null,
    },
    // Route without fetchById — states always null.
    "/api/no-fetch-things": {
      resourceType: "noFetchThing",
      action: "agent.created",
    },
    "/api/no-fetch-things/:id": {
      resourceType: "noFetchThing",
      actionByMethod: { PATCH: "agent.updated", DELETE: "agent.deleted" },
    },
    // Named param — verifies that nested routes don't fall back to params.id.
    "/api/agents/:agentId": {
      resourceType: "agent",
      resourceIdParam: "agentId",
      actionByMethod: { DELETE: "agent.deleted" },
      fetchById: async (id: string) =>
        id === KNOWN_RESOURCE_ID ? { id, name: "Some Agent" } : null,
    },
    // Explicit child route — POST to this path must NOT inherit agent config.
    "/api/agents/:agentId/tools/:toolId": {
      resourceType: "agentTool",
      resourceIdParam: "toolId",
      fetchById: async (
        toolId: string,
        _orgId: string,
        params?: Record<string, unknown>,
      ) =>
        toolId === KNOWN_RESOURCE_ID && typeof params?.agentId === "string"
          ? {
              id: "assignment-row-id",
              agentId: params.agentId,
              toolId,
            }
          : null,
    },
    // Rotation route with explicit action — key test for action overrides.
    "/api/user-tokens/me/rotate": {
      resourceType: "userToken",
      action: "userToken.rotated",
      resourceIdSource: "currentUserPersonalToken" as const,
    },
    // Bulk import — no fetchById/resourceIdSource; the handler supplies the
    // post-state via request.auditAfter and resourceId stays null.
    "/api/bulk-imports": {
      resourceType: "skill",
      action: "skill.imported",
    },
  };

  function resolveAuditableRouteConfig(routePattern: string | undefined) {
    if (!routePattern) return undefined;
    let p = routePattern;
    let viaWalkUp = false;
    for (;;) {
      const cfg = ROUTES[p];
      if (cfg) return { cfg, viaWalkUp };
      const lastSlash = p.lastIndexOf("/");
      if (lastSlash <= 0) return undefined;
      p = p.slice(0, lastSlash);
      viaWalkUp = true;
    }
  }

  function deriveAction(
    resourceType: string | null,
    method: string,
  ): import("@/types/audit-log").AuditEventName | null {
    if (!resourceType) return null;
    const verb =
      method === "POST"
        ? "created"
        : method === "PUT" || method === "PATCH"
          ? "updated"
          : method === "DELETE"
            ? "deleted"
            : null;
    if (!verb) return null;
    const candidate = `${resourceType}.${verb}`;
    return AuditEventNameSchema.safeParse(candidate).success
      ? (candidate as import("@/types/audit-log").AuditEventName)
      : null;
  }

  return {
    AUDITABLE_ROUTES: ROUTES,
    resolveAuditableRouteConfig,
    deriveAction,
    initAuditRegistry: vi.fn(),
  };
});

import logger from "@/logging";
import AuditLogModel from "@/models/audit-log";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { registerAuditLogHook } from "./audit-log-hook";

// Helper: inject user + org into every request, optionally with authMethod.
function injectAuth(
  app: FastifyInstanceWithZod,
  user: User,
  orgId: string,
  authMethod?: "session" | "api_key",
) {
  app.addHook("onRequest", async (request) => {
    (request as typeof request & { user: User }).user = user;
    (request as typeof request & { organizationId: string }).organizationId =
      orgId;
    if (authMethod) {
      (
        request as typeof request & { authMethod?: "session" | "api_key" }
      ).authMethod = authMethod;
    }
  });
}

describe("registerAuditLogHook", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let orgId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();

    user = await makeUser();
    const org = await makeOrganization();
    orgId = org.id;

    app = createFastifyInstance();
    injectAuth(app, user, orgId, "session");
    registerAuditLogHook(app);

    // Standard CRUD routes
    app.post("/api/things", async () => ({
      id: KNOWN_RESOURCE_ID,
      name: "New Thing",
    }));
    app.patch("/api/things/:id", async () => ({
      id: KNOWN_RESOURCE_ID,
      name: "Updated Thing",
    }));
    app.delete("/api/things/:id", async () => ({}));
    app.get("/api/things", async () => []);

    // 4xx routes
    app.post("/api/things/bad", async (_req, reply) =>
      reply.code(400).send({ error: { message: "bad request" } }),
    );
    app.patch("/api/things/:id/bad", async (_req, reply) =>
      reply.code(400).send({ error: { message: "bad request" } }),
    );
    app.post("/api/things/unauthorized", async (_req, reply) =>
      reply.code(401).send({ error: { message: "unauth" } }),
    );
    app.post("/api/things/forbidden", async (_req, reply) =>
      reply.code(403).send({ error: { message: "forbidden" } }),
    );

    // 5xx route
    app.post("/api/things/boom", async (_req, reply) =>
      reply.code(500).send({ error: { message: "boom" } }),
    );

    // 404 route — simulates a route handler that rejects a cross-org id.
    // The route pattern walks up to /api/things/:id, whose fetchById returns
    // null for any id that isn't KNOWN_RESOURCE_ID (cross-org scenario).
    app.patch("/api/things/:id/cross-org", async (_req, reply) => {
      reply.code(404).send({ error: { message: "not found" } });
    });

    // Route without fetchById in registry
    app.post("/api/no-fetch-things", async () => ({ id: KNOWN_RESOURCE_ID }));
    app.patch("/api/no-fetch-things/:id", async () => ({}));
    app.delete("/api/no-fetch-things/:id", async () => ({}));

    // Denylisted: health/ready probes
    app.post("/api/health", async () => ({ ok: true }));
    app.post("/api/ready", async () => ({ ok: true }));

    // Exact-denied: the chat streaming endpoint.
    // /api/chatops/* must NOT be caught by this entry — those routes
    // are registered for audit and must produce rows.
    app.post("/api/chat", async () => ({ ok: true }));

    // ChatOps mutations — must NOT be swallowed by the /api/chat denylist entry.
    app.post("/api/chatops/bindings", async () => ({
      id: KNOWN_RESOURCE_ID,
    }));
    app.post("/api/chatops/config/slack", async () => ({
      id: KNOWN_RESOURCE_ID,
    }));
    app.post("/api/chatops/channel-discovery/refresh", async () => ({
      id: KNOWN_RESOURCE_ID,
    }));

    // Prefix-denied: MCP session proxy
    app.post("/api/mcp/session", async () => ({ ok: true }));

    // Not in AUDITABLE_ROUTES — exercises fallback + logger.warn path.
    app.post("/api/orphan-events", async () => ({ ok: true }));

    // Nested route — verifies resourceIdParam guard (walk-up to /api/agents/:agentId).
    app.delete("/api/agents/:agentId/sub-resource/:id", async () => ({
      ok: true,
    }));

    // Explicitly registered child route — POST/DELETE use toolId param name.
    app.post("/api/agents/:agentId/tools/:toolId", async () => ({ ok: true }));
    app.delete("/api/agents/:agentId/tools/:toolId", async () => ({
      ok: true,
    }));

    // Unregistered child route — walks up to /api/agents/:agentId.
    // POST must be suppressed; PATCH must still write a row.
    app.post("/api/agents/:agentId/assign-tools", async () => ({ ok: true }));
    app.patch("/api/agents/:agentId/assign-tools", async () => ({ ok: true }));

    // GitHub read-only POSTs — exact denylist entries; must produce zero rows.
    app.post("/api/skills/github/discover", async () => ({ ok: true }));
    app.post("/api/skills/github/preview", async () => ({ ok: true }));

    // Token rotation route.
    app.post("/api/user-tokens/me/rotate", async () => ({ ok: true }));

    // Bulk import route — handler supplies the audit post-state directly.
    app.post("/api/bulk-imports", async (request, reply) => {
      request.auditAfter = {
        created: [{ id: "skill-1", name: "Skill One" }],
        skipped: ["repo/bad-skill"],
      };
      return reply.send({ ok: true });
    });

    // Non-mutating verbs
    app.route({
      method: "HEAD",
      url: "/api/head-things",
      handler: async () => ({}),
    });
    app.route({
      method: "OPTIONS",
      url: "/api/options-things",
      handler: async () => ({}),
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // Helper: wait for the async audit write to settle.
  async function settle() {
    await new Promise((r) => setTimeout(r, 50));
  }

  async function getRows() {
    const { data } = await AuditLogModel.findPaginated({
      organizationId: orgId,
      limit: 50,
      offset: 0,
    });
    return data;
  }

  describe("POST — success", () => {
    test("writes row with action=agent.created, before=null, after populated, outcome=success", async () => {
      const res = await app.inject({ method: "POST", url: "/api/things" });
      expect(res.statusCode).toBe(200);
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("agent.created");
      expect(rows[0].outcome).toBe("success");
      expect(rows[0].before).toBeNull();
      expect(rows[0].after).toEqual({
        id: KNOWN_RESOURCE_ID,
        name: "Existing Thing",
      });
      expect(rows[0].httpMethod).toBe("POST");
      expect(rows[0].httpStatus).toBe(200);
      expect(rows[0].actorId).toBe(user.id);
    });

    test("captures id from { data: { id } } envelope", async () => {
      const envelopeApp = createFastifyInstance();
      injectAuth(envelopeApp, user, orgId, "session");
      registerAuditLogHook(envelopeApp);
      envelopeApp.post("/api/things", async () => ({
        data: { id: KNOWN_RESOURCE_ID, name: "Wrapped Thing" },
      }));
      await envelopeApp.ready();

      await envelopeApp.inject({ method: "POST", url: "/api/things" });
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].resourceId).toBe(KNOWN_RESOURCE_ID);
      expect(rows[0].after).toEqual({
        id: KNOWN_RESOURCE_ID,
        name: "Existing Thing",
      });

      await envelopeApp.close();
    });
  });

  describe("handler-supplied after (request.auditAfter)", () => {
    test("uses request.auditAfter verbatim and leaves resourceId null", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/bulk-imports",
      });
      expect(res.statusCode).toBe(200);
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("skill.imported");
      expect(rows[0].outcome).toBe("success");
      expect(rows[0].resourceId).toBeNull();
      expect(rows[0].before).toBeNull();
      expect(rows[0].after).toEqual({
        created: [{ id: "skill-1", name: "Skill One" }],
        skipped: ["repo/bad-skill"],
      });
    });
  });

  describe("PATCH — success", () => {
    test("writes row with action=agent.updated, before and after both populated", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/things/${KNOWN_RESOURCE_ID}`,
        payload: { name: "Updated" },
      });
      expect(res.statusCode).toBe(200);
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("agent.updated");
      expect(rows[0].outcome).toBe("success");
      expect(rows[0].before).toEqual({
        id: KNOWN_RESOURCE_ID,
        name: "Existing Thing",
      });
      expect(rows[0].after).toEqual({
        id: KNOWN_RESOURCE_ID,
        name: "Existing Thing",
      });
      expect(rows[0].resourceId).toBe(KNOWN_RESOURCE_ID);
    });

    test("before and after differ when fetchById returns different snapshots", async () => {
      const registry = (await import(
        "./audit-log-registry"
      )) as typeof import("./audit-log-registry");
      const routeCfg = registry.AUDITABLE_ROUTES["/api/things/:id"];
      const origFetch = routeCfg.fetchById;
      let call = 0;
      routeCfg.fetchById = async (id: string) => {
        call += 1;
        if (call === 1) return { id, name: "Before patch", rev: 1 };
        return { id, name: "After patch", rev: 2 };
      };
      try {
        await app.inject({
          method: "PATCH",
          url: `/api/things/${KNOWN_RESOURCE_ID}`,
          payload: { name: "n/a" },
        });
        await settle();

        const rows = await getRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].before).toEqual({
          id: KNOWN_RESOURCE_ID,
          name: "Before patch",
          rev: 1,
        });
        expect(rows[0].after).toEqual({
          id: KNOWN_RESOURCE_ID,
          name: "After patch",
          rev: 2,
        });
      } finally {
        routeCfg.fetchById = origFetch;
      }
    });
  });

  describe("DELETE — success", () => {
    test("writes row with action=agent.deleted, before populated, after=null", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/things/${KNOWN_RESOURCE_ID}`,
      });
      expect(res.statusCode).toBe(200);
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("agent.deleted");
      expect(rows[0].outcome).toBe("success");
      expect(rows[0].before).toEqual({
        id: KNOWN_RESOURCE_ID,
        name: "Existing Thing",
      });
      expect(rows[0].after).toBeNull();
    });
  });

  describe("4xx responses — rows written with correct outcome", () => {
    test("POST 400 writes row with outcome=failure, before=null, after=null", async () => {
      const res = await app.inject({ method: "POST", url: "/api/things/bad" });
      expect(res.statusCode).toBe(400);
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe("failure");
      expect(rows[0].before).toBeNull();
      expect(rows[0].after).toBeNull();
    });

    test("POST 401 writes row with outcome=denied", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/things/unauthorized",
      });
      expect(res.statusCode).toBe(401);
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe("denied");
      expect(rows[0].after).toBeNull();
    });

    test("POST 403 writes row with outcome=denied", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/things/forbidden",
      });
      expect(res.statusCode).toBe(403);
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe("denied");
      expect(rows[0].after).toBeNull();
    });

    test("PATCH 400 writes row with outcome=failure, before captured from preHandler, after=null", async () => {
      // before is captured in preHandler (before the handler returns 400).
      const res = await app.inject({
        method: "PATCH",
        url: `/api/things/${KNOWN_RESOURCE_ID}/bad`,
      });
      expect(res.statusCode).toBe(400);
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe("failure");
      // before was captured in preHandler because fetchById for /api/things/:id exists.
      expect(rows[0].before).toEqual({
        id: KNOWN_RESOURCE_ID,
        name: "Existing Thing",
      });
      expect(rows[0].after).toBeNull();
    });
  });

  describe("5xx responses — row written with outcome=failure", () => {
    test("POST 500 writes row with outcome=failure", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/things/boom",
      });
      expect(res.statusCode).toBe(500);
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe("failure");
      expect(rows[0].after).toBeNull();
    });
  });

  describe("action resolution", () => {
    test("explicit action override wins: POST /api/user-tokens/me/rotate → userToken.rotated", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/user-tokens/me/rotate",
      });
      // Route returns 200 OK (no body id needed — resourceIdSource handles it)
      expect(res.statusCode).toBe(200);
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("userToken.rotated");
    });

    test("unregistered route uses unknown.* fallback and logs a warning", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/orphan-events",
      });
      expect(res.statusCode).toBe(200);
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("unknown.created");
      expect(rows[0].resourceType).toBeNull();

      expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.warn).mock.calls[0][1]).toMatch(
        /no action resolved/,
      );
    });
  });

  describe("actor_type stamping", () => {
    test("session caller → actorType=user", async () => {
      // Default app already injects authMethod="session"
      await app.inject({ method: "POST", url: "/api/things" });
      await settle();

      const rows = await getRows();
      expect(rows[0].actorType).toBe("user");
    });

    test("api_key caller → actorType=api_key, actorId=owning user id", async () => {
      const apiKeyApp = createFastifyInstance();
      injectAuth(apiKeyApp, user, orgId, "api_key");
      registerAuditLogHook(apiKeyApp);
      apiKeyApp.post("/api/things", async () => ({
        id: KNOWN_RESOURCE_ID,
        name: "New Thing",
      }));
      await apiKeyApp.ready();

      await apiKeyApp.inject({ method: "POST", url: "/api/things" });
      await settle();

      const rows = await getRows();
      expect(rows[0].actorType).toBe("api_key");
      // actorId is the owning user's ID (FK → usersTable); actorType is the auth-method signal.
      expect(rows[0].actorId).toBe(user.id);

      await apiKeyApp.close();
    });

    test("authMethod absent → actorType defaults to user", async () => {
      const noMethodApp = createFastifyInstance();
      // Inject without authMethod
      noMethodApp.addHook("onRequest", async (request) => {
        (request as typeof request & { user: User }).user = user;
        (
          request as typeof request & { organizationId: string }
        ).organizationId = orgId;
      });
      registerAuditLogHook(noMethodApp);
      noMethodApp.post("/api/things", async () => ({
        id: KNOWN_RESOURCE_ID,
      }));
      await noMethodApp.ready();

      await noMethodApp.inject({ method: "POST", url: "/api/things" });
      await settle();

      const rows = await getRows();
      expect(rows[0].actorType).toBe("user");

      await noMethodApp.close();
    });
  });

  describe("request_id and occurred_at", () => {
    test("row.requestId is populated from Fastify's request.id", async () => {
      await app.inject({ method: "POST", url: "/api/things" });
      await settle();

      const rows = await getRows();
      expect(rows[0].requestId).toBeTruthy();
      expect(typeof rows[0].requestId).toBe("string");
    });

    test("row.occurredAt is a Date and not after createdAt", async () => {
      await app.inject({ method: "POST", url: "/api/things" });
      await settle();

      const rows = await getRows();
      expect(rows[0].occurredAt).toBeInstanceOf(Date);
      expect(rows[0].createdAt).toBeInstanceOf(Date);
      // occurred_at is stamped in preHandler, createdAt is the DB write time —
      // occurred_at must be <= createdAt.
      expect(rows[0].occurredAt.getTime()).toBeLessThanOrEqual(
        rows[0].createdAt.getTime(),
      );
    });
  });

  describe("GET — not audited", () => {
    test("GET request writes zero rows", async () => {
      await app.inject({ method: "GET", url: "/api/things" });
      await settle();
      expect(await getRows()).toHaveLength(0);
    });
  });

  describe("no request.user — not audited", () => {
    test("unauthenticated request writes zero rows", async () => {
      const noAuthApp = createFastifyInstance();
      registerAuditLogHook(noAuthApp);
      noAuthApp.post("/api/things", async () => ({ id: KNOWN_RESOURCE_ID }));
      await noAuthApp.ready();

      const res = await noAuthApp.inject({
        method: "POST",
        url: "/api/things",
      });
      await settle();

      expect(res.statusCode).toBe(200);
      expect(await getRows()).toHaveLength(0);

      await noAuthApp.close();
    });
  });

  describe("fetchById absent — row written with null states", () => {
    test("route without fetchById records action and resourceType but null states", async () => {
      await app.inject({ method: "POST", url: "/api/no-fetch-things" });
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("agent.created");
      expect(rows[0].resourceType).toBe("noFetchThing");
      expect(rows[0].before).toBeNull();
      expect(rows[0].after).toBeNull();
    });
  });

  describe("HEAD / OPTIONS — not audited", () => {
    test("HEAD writes zero rows", async () => {
      await app.inject({ method: "HEAD", url: "/api/head-things" });
      await settle();
      expect(await getRows()).toHaveLength(0);
    });

    test("OPTIONS writes zero rows", async () => {
      await app.inject({ method: "OPTIONS", url: "/api/options-things" });
      await settle();
      expect(await getRows()).toHaveLength(0);
    });
  });

  describe("denylisted paths — not audited", () => {
    test("POST /api/health writes zero rows", async () => {
      await app.inject({ method: "POST", url: "/api/health" });
      await settle();
      expect(await getRows()).toHaveLength(0);
    });

    test("POST /api/ready writes zero rows", async () => {
      await app.inject({ method: "POST", url: "/api/ready" });
      await settle();
      expect(await getRows()).toHaveLength(0);
    });

    // /api/chat is the long-running stream endpoint; exact-match denial.
    test("POST /api/chat writes zero rows (exact denylist entry)", async () => {
      await app.inject({ method: "POST", url: "/api/chat" });
      await settle();
      expect(await getRows()).toHaveLength(0);
    });

    // MCP session proxy — prefix entry must still suppress these.
    test("POST /api/mcp/session writes zero rows (prefix denylist entry)", async () => {
      await app.inject({ method: "POST", url: "/api/mcp/session" });
      await settle();
      expect(await getRows()).toHaveLength(0);
    });

    // Read-only embedding connection test — exact denylist entry so a failed
    // probe never records a misleading "Success" outcome.
    test("POST /api/organization/knowledge-settings/test-embedding writes zero rows", async () => {
      await app.inject({
        method: "POST",
        url: "/api/organization/knowledge-settings/test-embedding",
      });
      await settle();
      expect(await getRows()).toHaveLength(0);
    });
  });

  describe("denylist — /api/chatops/* must not be swallowed by /api/chat exact entry", () => {
    // These tests are the regression guard for the bug where a prefix-matched
    // "/api/chat" silenced every /api/chatops/* mutation.  With an exact entry
    // only POST /api/chat itself is excluded; the chatops routes must produce
    // audit rows.

    test("POST /api/chatops/bindings writes a row", async () => {
      await app.inject({ method: "POST", url: "/api/chatops/bindings" });
      await settle();
      // One row expected — action/resourceType are unknown.* because the mock
      // registry has no chatops entries, but the key assertion is that the
      // denylist no longer swallows the request.
      expect(await getRows()).toHaveLength(1);
    });

    test("POST /api/chatops/config/slack writes a row", async () => {
      await app.inject({ method: "POST", url: "/api/chatops/config/slack" });
      await settle();
      expect(await getRows()).toHaveLength(1);
    });

    test("POST /api/chatops/channel-discovery/refresh writes a row", async () => {
      await app.inject({
        method: "POST",
        url: "/api/chatops/channel-discovery/refresh",
      });
      await settle();
      expect(await getRows()).toHaveLength(1);
    });

    test("/api/chat exact denial does not affect /api/chatops/* (both in same request batch)", async () => {
      // Fire the denied route first, then a chatops route.  Only the chatops
      // request should produce a row — proves the two are handled independently.
      await app.inject({ method: "POST", url: "/api/chat" });
      await app.inject({ method: "POST", url: "/api/chatops/bindings" });
      await settle();
      expect(await getRows()).toHaveLength(1);
    });
  });

  describe("http_path — query string is stripped before persisting", () => {
    test("POST /api/things?token=secret&debug=1 stores path only", async () => {
      // Query strings can contain secrets (?token=, ?key=).  audit_logs is
      // long-lived admin-readable storage and exposes httpPath via an `ilike`
      // search filter — persisting query params would create a permanent,
      // searchable secret leak.
      const res = await app.inject({
        method: "POST",
        url: "/api/things?token=should-not-be-persisted&debug=1",
      });
      expect(res.statusCode).toBe(200);
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].httpPath).toBe("/api/things");
      expect(rows[0].httpPath).not.toContain("token");
      expect(rows[0].httpPath).not.toContain("?");
    });

    test("URL without a query string is recorded unchanged", async () => {
      await app.inject({ method: "POST", url: "/api/things" });
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].httpPath).toBe("/api/things");
    });
  });

  describe("source_ip", () => {
    test("records sourceIp from request (not raw forwarded headers)", async () => {
      await app.inject({
        method: "POST",
        url: "/api/things",
        headers: { "x-forwarded-for": "1.2.3.4" },
      });
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].sourceIp).not.toBeNull();
      // inject() uses loopback; should not be the spoofed forwarded value
      // when trustProxy=false (Fastify default in test env).
      expect(rows[0].sourceIp).not.toBe("1.2.3.4");
    });
  });

  describe("resourceIdParam — nested routes use the named param", () => {
    test("nested route records the agentId, not the tool :id", async () => {
      const agentId = KNOWN_RESOURCE_ID;
      const childId = "00000000-0000-0000-0000-000000000999";

      await app.inject({
        method: "DELETE",
        url: `/api/agents/${agentId}/sub-resource/${childId}`,
      });
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].resourceType).toBe("agent");
      expect(rows[0].resourceId).toBe(agentId);
      expect(rows[0].resourceId).not.toBe(childId);
    });
  });

  describe("fetchById throws — row still written", () => {
    test("PATCH with throwing fetchById writes a row with null states", async () => {
      const registry = (await import(
        "./audit-log-registry"
      )) as typeof import("./audit-log-registry");
      const throwing = vi
        .spyOn(registry.AUDITABLE_ROUTES["/api/things/:id"], "fetchById")
        .mockImplementation(async () => {
          throw new Error("fetchById exploded");
        });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/things/${KNOWN_RESOURCE_ID}`,
      });
      expect(res.statusCode).toBe(200);
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("agent.updated");
      expect(rows[0].before).toBeNull();
      expect(rows[0].after).toBeNull();

      expect(
        vi
          .mocked(logger.error)
          .mock.calls.some(
            (call: readonly unknown[]) =>
              typeof call[1] === "string" &&
              (call[1] as string).includes("fetchById"),
          ),
      ).toBe(true);

      throwing.mockRestore();
    });
  });

  describe("AuditLogModel.create rejects — request still completes", () => {
    test("create failure does not affect response and logs error", async () => {
      const createSpy = vi
        .spyOn(AuditLogModel, "create")
        .mockRejectedValueOnce(new Error("DB write failed"));

      const res = await app.inject({ method: "POST", url: "/api/things" });
      expect(res.statusCode).toBe(200);
      await settle();

      expect(
        vi
          .mocked(logger.error)
          .mock.calls.some(
            (call: readonly unknown[]) =>
              typeof call[1] === "string" &&
              (call[1] as string).includes("failed to write audit log row"),
          ),
      ).toBe(true);

      createSpy.mockRestore();
    });
  });

  describe("snapshot-before-authz — before=null when fetchById returns null for cross-org id", () => {
    test("PATCH 404 with cross-org id: row written with before=null and outcome=failure", async () => {
      // Simulates: admin in org A issues PATCH /api/internal_mcp_catalog/<org-B-uuid>.
      // The audit preHandler runs fetchById with (orgB_id, orgA_orgId) which returns null
      // (the resource is not visible to org A). The route handler returns 404.
      // The resulting audit row must have before=null — not org B's snapshot.
      const crossOrgId = "00000000-0000-0000-0000-000000000002"; // not KNOWN_RESOURCE_ID
      const res = await app.inject({
        method: "PATCH",
        url: `/api/things/${crossOrgId}/cross-org`,
      });
      expect(res.statusCode).toBe(404);
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe("failure"); // 404 maps to failure
      expect(rows[0].before).toBeNull(); // fetchById returned null for the cross-org id
      expect(rows[0].after).toBeNull(); // non-success → after never fetched
    });
  });

  describe("explicit child route — POST must use its own config, not the parent's", () => {
    test("POST to explicitly-registered child route writes an agentTool row", async () => {
      // /api/agents/:agentId/tools/:toolId is registered with resourceType="agentTool"
      // and resourceIdParam="toolId".  A POST here must NOT inherit agent config
      // and must NOT record agentId as the resourceId.
      const agentId = "00000000-0000-0000-0000-000000000010";
      await app.inject({
        method: "POST",
        url: `/api/agents/${agentId}/tools/${KNOWN_RESOURCE_ID}`,
      });
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].resourceType).toBe("agentTool");
      // resourceIdParam="toolId" → resourceId is the tool id, not the agent id
      expect(rows[0].resourceId).toBe(KNOWN_RESOURCE_ID);
      expect(rows[0].resourceId).not.toBe(agentId);
    });

    test("DELETE on agent-tool route passes agentId to fetchById for before snapshot", async () => {
      const agentId = "00000000-0000-0000-0000-000000000010";
      await app.inject({
        method: "DELETE",
        url: `/api/agents/${agentId}/tools/${KNOWN_RESOURCE_ID}`,
      });
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].before).toEqual({
        id: "assignment-row-id",
        agentId,
        toolId: KNOWN_RESOURCE_ID,
      });
    });

    test("PATCH to an unregistered child route inherits parent config via walk-up", async () => {
      const agentId = KNOWN_RESOURCE_ID;
      await app.inject({
        method: "PATCH",
        url: `/api/agents/${agentId}/assign-tools`,
      });
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].resourceType).toBe("agent");
      expect(rows[0].resourceId).toBe(agentId);
    });

    test("POST to an unregistered child route suppresses parent config walk-up", async () => {
      const thingId = KNOWN_RESOURCE_ID;
      await app.inject({
        method: "POST",
        url: `/api/things/${thingId}/assign-tools`,
      });
      await settle();

      const rows = await getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].resourceType).toBeNull(); // walk-up suppressed for POST
      expect(rows[0].action).toBe("unknown.created");
    });
  });

  describe("denylist — GitHub read-only POST endpoints", () => {
    test("POST /api/skills/github/discover writes zero rows", async () => {
      await app.inject({ method: "POST", url: "/api/skills/github/discover" });
      await settle();
      expect(await getRows()).toHaveLength(0);
    });

    test("POST /api/skills/github/preview writes zero rows", async () => {
      await app.inject({ method: "POST", url: "/api/skills/github/preview" });
      await settle();
      expect(await getRows()).toHaveLength(0);
    });

    test("POST /api/skills/github/discover?repo=abc writes zero rows (query string must not bypass exact denylist)", async () => {
      await app.inject({
        method: "POST",
        url: "/api/skills/github/discover?repo=abc&branch=main",
      });
      await settle();
      expect(await getRows()).toHaveLength(0);
    });

    test("POST /api/skills/github/preview?branch=main writes zero rows (query string must not bypass exact denylist)", async () => {
      await app.inject({
        method: "POST",
        url: "/api/skills/github/preview?branch=main",
      });
      await settle();
      expect(await getRows()).toHaveLength(0);
    });
  });

  describe("denylist — high-volume chat surface sub-routes", () => {
    test("POST /api/chat stream endpoint writes zero rows", async () => {
      await app.inject({ method: "POST", url: "/api/chat" });
      await settle();
      expect(await getRows()).toHaveLength(0);
    });

    test("POST /api/chat?session=abc writes zero rows (query string must not bypass exact denylist)", async () => {
      await app.inject({
        method: "POST",
        url: "/api/chat?session=abc&debug=1",
      });
      await settle();
      expect(await getRows()).toHaveLength(0);
    });

    test("POST /api/chat/conversations writes zero rows", async () => {
      await app.inject({ method: "POST", url: "/api/chat/conversations" });
      await settle();
      expect(await getRows()).toHaveLength(0);
    });

    test("DELETE /api/chat/messages/123 writes zero rows", async () => {
      await app.inject({ method: "DELETE", url: "/api/chat/messages/123" });
      await settle();
      expect(await getRows()).toHaveLength(0);
    });
  });
});
