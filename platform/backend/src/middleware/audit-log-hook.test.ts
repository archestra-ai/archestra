import { vi } from "vitest";

/**
 * Contract: registerAuditLogHook — mutating /api/* success path writes AuditLogModel rows;
 * denylist, method filter, unauthenticated skip, 4xx/5xx skip; fetch/create failures log and never break responses.
 */

// vi.hoisted ensures this is available both in mock factories and in test code.
const KNOWN_RESOURCE_ID = vi.hoisted(
  () => "00000000-0000-0000-0000-000000000001",
);

// The logger is a Proxy at runtime, so vi.spyOn can't intercept its properties.
// Hoist a real mock fn and replace the module entirely.
const logErrorFn = vi.hoisted(() => vi.fn());

vi.mock("@/logging", () => ({
  default: {
    error: logErrorFn,
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("./audit-log-registry", () => {
  const ROUTES: Record<
    string,
    import("./audit-log-registry").AuditableRouteConfig
  > = {
    "/api/things": {
      resourceType: "thing",
      fetchById: async (id: string) =>
        id === KNOWN_RESOURCE_ID ? { id, name: "Existing Thing" } : null,
    },
    "/api/things/:id": {
      resourceType: "thing",
      fetchById: async (id: string) =>
        id === KNOWN_RESOURCE_ID ? { id, name: "Existing Thing" } : null,
    },
    "/api/no-fetch-things": { resourceType: "noFetchThing" },
    "/api/no-fetch-things/:id": { resourceType: "noFetchThing" },
    // Parent route that wants the `agentId` param (NOT `id`). Used to verify
    // that nested routes like `/api/agents/:agentId/tools/:id` don't
    // accidentally fall back to `params.id` (the child resource id).
    "/api/agents/:agentId": {
      resourceType: "agent",
      resourceIdParam: "agentId",
      fetchById: async (id: string) =>
        id === KNOWN_RESOURCE_ID ? { id, name: "Some Agent" } : null,
    },
  };

  function resolveAuditableRouteConfig(
    routePattern: string | undefined,
  ): import("./audit-log-registry").AuditableRouteConfig | undefined {
    if (!routePattern) return undefined;
    let p = routePattern;
    for (;;) {
      const cfg = ROUTES[p];
      if (cfg) return cfg;
      const lastSlash = p.lastIndexOf("/");
      if (lastSlash <= 0) return undefined;
      p = p.slice(0, lastSlash);
    }
  }

  return {
    AUDITABLE_ROUTES: ROUTES,
    resolveAuditableRouteConfig,
    initAuditRegistry: vi.fn(),
  };
});

import AuditLogModel from "@/models/audit-log";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { registerAuditLogHook } from "./audit-log-hook";

describe("registerAuditLogHook", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let orgId: string;
  let logErrorSpy: ReturnType<typeof vi.fn>;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    // logErrorFn is already the hoisted mock — just alias it for test assertions.
    logErrorSpy = logErrorFn;

    user = await makeUser();
    const org = await makeOrganization();
    orgId = org.id;

    app = createFastifyInstance();

    // Inject user + org into every request (simulates fastifyAuthPlugin)
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        orgId;
    });

    registerAuditLogHook(app);

    // Minimal routes that satisfy the test scenarios
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

    // Route that returns 400 on POST
    app.post("/api/things/bad", async (_req, reply) => {
      return reply.code(400).send({ error: { message: "bad request" } });
    });

    // Route that has no fetchById in registry
    app.post("/api/no-fetch-things", async () => ({ id: KNOWN_RESOURCE_ID }));
    app.patch("/api/no-fetch-things/:id", async () => ({}));
    app.delete("/api/no-fetch-things/:id", async () => ({}));

    // Route used to exercise 5xx skip path
    app.post("/api/things/boom", async (_req, reply) => {
      return reply.code(500).send({ error: { message: "boom" } });
    });

    // Denylisted path (must NOT be audited even with mutating verb)
    app.post("/api/health", async () => ({ ok: true }));
    app.post("/api/ready", async () => ({ ok: true }));

    // Not in AUDITABLE_ROUTES — exercises registry gap row (resource_type null).
    app.post("/api/orphan-events", async () => ({ ok: true }));

    // Nested route under an agent — exercises the resourceIdParam fallback
    // behavior (must NOT silently substitute `params.id` for the missing
    // `agentId`).
    app.delete("/api/agents/:agentId/tools/:id", async () => ({ ok: true }));

    // HEAD / OPTIONS — non-mutating verbs (use distinct URLs to avoid
    // conflict with the GET /api/things that Fastify auto-promotes to HEAD).
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

  describe("POST — create action", () => {
    test("writes one row with action=create, prior_state=null, post_state populated", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/things",
      });

      expect(res.statusCode).toBe(200);

      // Give the async write a moment to settle
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });

      expect(data).toHaveLength(1);
      expect(data[0].action).toBe("create");
      expect(data[0].resourceType).toBe("thing");
      expect(data[0].priorState).toBeNull();
      expect(data[0].postState).toEqual({
        id: KNOWN_RESOURCE_ID,
        name: "Existing Thing",
      });
      expect(data[0].httpMethod).toBe("POST");
      expect(data[0].httpStatus).toBe(200);
      expect(data[0].actorUserId).toBe(user.id);
    });
  });

  describe("POST — id capture from envelope responses", () => {
    test("captures id from `{ data: { id } }` envelope so post_state is populated", async () => {
      // Mount a fresh route that returns the wrapped shape some routes use.
      const envelopeApp = createFastifyInstance();
      envelopeApp.addHook("onRequest", async (request) => {
        (request as typeof request & { user: User }).user = user;
        (
          request as typeof request & { organizationId: string }
        ).organizationId = orgId;
      });
      registerAuditLogHook(envelopeApp);
      envelopeApp.post("/api/things", async () => ({
        data: { id: KNOWN_RESOURCE_ID, name: "Wrapped Thing" },
      }));
      await envelopeApp.ready();

      const res = await envelopeApp.inject({
        method: "POST",
        url: "/api/things",
      });
      expect(res.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });

      expect(data).toHaveLength(1);
      expect(data[0].resourceId).toBe(KNOWN_RESOURCE_ID);
      expect(data[0].postState).toEqual({
        id: KNOWN_RESOURCE_ID,
        name: "Existing Thing",
      });

      await envelopeApp.close();
    });
  });

  describe("PATCH — update action", () => {
    test("writes one row with action=update, both prior_state and post_state populated", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/things/${KNOWN_RESOURCE_ID}`,
        payload: { name: "Updated" },
      });

      expect(res.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });

      expect(data).toHaveLength(1);
      expect(data[0].action).toBe("update");
      expect(data[0].priorState).toEqual({
        id: KNOWN_RESOURCE_ID,
        name: "Existing Thing",
      });
      expect(data[0].postState).toEqual({
        id: KNOWN_RESOURCE_ID,
        name: "Existing Thing",
      });
      expect(data[0].resourceId).toBe(KNOWN_RESOURCE_ID);
    });

    test("persisted prior_state and post_state differ when fetchById returns different snapshots", async () => {
      const registry = (await import(
        "./audit-log-registry"
      )) as typeof import("./audit-log-registry");
      const routeCfg = registry.AUDITABLE_ROUTES["/api/things/:id"];
      const origFetch = routeCfg.fetchById;
      let call = 0;
      routeCfg.fetchById = async (id: string, _organizationId: string) => {
        call += 1;
        if (call === 1) return { id, name: "Before patch", rev: 1 };
        return { id, name: "After patch", rev: 2 };
      };
      try {
        const res = await app.inject({
          method: "PATCH",
          url: `/api/things/${KNOWN_RESOURCE_ID}`,
          payload: { name: "n/a" },
        });
        expect(res.statusCode).toBe(200);
        await new Promise((r) => setTimeout(r, 50));

        const { data } = await AuditLogModel.findPaginated({
          organizationId: orgId,
          limit: 10,
          offset: 0,
        });

        expect(data).toHaveLength(1);
        expect(data[0].priorState).toEqual({
          id: KNOWN_RESOURCE_ID,
          name: "Before patch",
          rev: 1,
        });
        expect(data[0].postState).toEqual({
          id: KNOWN_RESOURCE_ID,
          name: "After patch",
          rev: 2,
        });
      } finally {
        routeCfg.fetchById = origFetch;
      }
    });
  });

  describe("DELETE — delete action", () => {
    test("writes one row with action=delete, prior_state populated, post_state=null", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/things/${KNOWN_RESOURCE_ID}`,
      });

      expect(res.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });

      expect(data).toHaveLength(1);
      expect(data[0].action).toBe("delete");
      expect(data[0].priorState).toEqual({
        id: KNOWN_RESOURCE_ID,
        name: "Existing Thing",
      });
      expect(data[0].postState).toBeNull();
    });
  });

  describe("GET — not audited", () => {
    test("GET request writes zero rows", async () => {
      await app.inject({ method: "GET", url: "/api/things" });
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });

      expect(data).toHaveLength(0);
    });
  });

  describe("4xx responses — not audited", () => {
    test("POST returning 400 writes zero rows", async () => {
      const res = await app.inject({ method: "POST", url: "/api/things/bad" });
      expect(res.statusCode).toBe(400);
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });

      expect(data).toHaveLength(0);
    });
  });

  describe("no request.user — not audited", () => {
    test("request without user writes zero rows and does not throw", async () => {
      // Create a separate app with NO user hook
      const noAuthApp = createFastifyInstance();
      registerAuditLogHook(noAuthApp);
      noAuthApp.post("/api/things", async () => ({ id: KNOWN_RESOURCE_ID }));
      await noAuthApp.ready();

      const res = await noAuthApp.inject({
        method: "POST",
        url: "/api/things",
      });

      // Hook should silently skip, not crash the response
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });

      expect(data).toHaveLength(0);

      await noAuthApp.close();

      // The inject call itself should have succeeded (no 500)
      expect(res.statusCode).toBe(200);
    });
  });

  describe("fetchById absent — row written with null states", () => {
    test("route without fetchById records action and resource_type but null states", async () => {
      await app.inject({ method: "POST", url: "/api/no-fetch-things" });
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });

      expect(data).toHaveLength(1);
      expect(data[0].action).toBe("create");
      expect(data[0].resourceType).toBe("noFetchThing");
      expect(data[0].priorState).toBeNull();
      expect(data[0].postState).toBeNull();
    });
  });

  describe("HEAD / OPTIONS — not audited", () => {
    test("HEAD writes zero rows", async () => {
      await app.inject({ method: "HEAD", url: "/api/head-things" });
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });
      expect(data).toHaveLength(0);
    });

    test("OPTIONS writes zero rows", async () => {
      await app.inject({ method: "OPTIONS", url: "/api/options-things" });
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });
      expect(data).toHaveLength(0);
    });
  });

  describe("5xx responses — not audited", () => {
    test("POST returning 500 writes zero rows", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/things/boom",
      });
      expect(res.statusCode).toBe(500);
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });
      expect(data).toHaveLength(0);
    });
  });

  describe("denylisted paths — not audited", () => {
    test("POST /api/health writes zero rows", async () => {
      const res = await app.inject({ method: "POST", url: "/api/health" });
      expect(res.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });
      expect(data).toHaveLength(0);
    });

    test("POST /api/ready writes zero rows", async () => {
      const res = await app.inject({ method: "POST", url: "/api/ready" });
      expect(res.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });
      expect(data).toHaveLength(0);
    });
  });

  describe("unregistered mutating route — gap row", () => {
    test("POST /api/orphan-events writes a row with null resource_type and null states", async () => {
      await app.inject({ method: "POST", url: "/api/orphan-events" });
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });

      expect(data).toHaveLength(1);
      expect(data[0].action).toBe("create");
      expect(data[0].resourceType).toBeNull();
      expect(data[0].priorState).toBeNull();
      expect(data[0].postState).toBeNull();
    });
  });

  describe("fetchById throws — row still written with null state", () => {
    test("PATCH with throwing fetchById produces a row with null states", async () => {
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
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });

      expect(data).toHaveLength(1);
      expect(data[0].action).toBe("update");
      expect(data[0].priorState).toBeNull();
      expect(data[0].postState).toBeNull();

      expect(
        logErrorSpy.mock.calls.some(
          (call: readonly unknown[]) =>
            typeof call[1] === "string" &&
            (call[1] as string).includes("fetchById"),
        ),
      ).toBe(true);

      throwing.mockRestore();
    });
  });

  describe("resourceIdParam — nested routes use the named param", () => {
    test("nested route /api/agents/:agentId/tools/:id records the agentId, not the tool :id", async () => {
      // The registry maps /api/agents/:agentId with resourceIdParam=agentId.
      // A nested request resolves to that parent config via longest-prefix
      // walking. Without the resourceIdParam guard, the hook would have
      // silently fallen back to params.id (the *tool* id) and recorded the
      // wrong resource id under resourceType=agent.
      const agentId = KNOWN_RESOURCE_ID;
      const toolId = "00000000-0000-0000-0000-000000000999";
      const res = await app.inject({
        method: "DELETE",
        url: `/api/agents/${agentId}/tools/${toolId}`,
      });
      expect(res.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });
      expect(data).toHaveLength(1);
      expect(data[0].resourceType).toBe("agent");
      expect(data[0].resourceId).toBe(agentId);
      expect(data[0].resourceId).not.toBe(toolId);
    });
  });

  describe("IP address", () => {
    test("records request.ip when available (trusts Fastify's resolved IP over forwarded headers)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/things",
        headers: {
          "x-forwarded-for": "1.2.3.4",
          "x-real-ip": "5.6.7.8",
        },
      });
      expect(res.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 50));

      const { data } = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 10,
        offset: 0,
      });

      expect(data).toHaveLength(1);
      // With trustProxy=false, request.ip is the socket address (127.0.0.1
      // under fastify.inject) and takes priority over forwarded headers.
      expect(data[0].ipAddress).not.toBeNull();
      expect(data[0].ipAddress).not.toBe("1.2.3.4");
      expect(data[0].ipAddress).not.toBe("5.6.7.8");
    });
  });

  describe("AuditLogModel.create rejects — request still completes", () => {
    test("create failure does not affect response and logs error", async () => {
      const createSpy = vi
        .spyOn(AuditLogModel, "create")
        .mockRejectedValueOnce(new Error("DB write failed"));

      const res = await app.inject({ method: "POST", url: "/api/things" });

      expect(res.statusCode).toBe(200);

      await new Promise((r) => setTimeout(r, 50));

      expect(
        logErrorSpy.mock.calls.some(
          (call: readonly unknown[]) =>
            typeof call[1] === "string" &&
            (call[1] as string).includes("failed to write audit log row"),
        ),
      ).toBe(true);

      createSpy.mockRestore();
    });
  });
});
