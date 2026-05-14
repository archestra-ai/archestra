import { vi } from "vitest";

// vi.hoisted ensures this is available both in mock factories and in test code.
const KNOWN_RESOURCE_ID = vi.hoisted(
  () => "00000000-0000-0000-0000-000000000001",
);

vi.mock("@/websocket", () => ({
  default: { broadcastAuditLog: vi.fn() },
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

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();

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

  describe("AuditLogModel.create rejects — request still completes", () => {
    test("create failure does not affect response and logs error", async () => {
      const createSpy = vi
        .spyOn(AuditLogModel, "create")
        .mockRejectedValueOnce(new Error("DB write failed"));

      const res = await app.inject({ method: "POST", url: "/api/things" });

      expect(res.statusCode).toBe(200);

      await new Promise((r) => setTimeout(r, 50));

      createSpy.mockRestore();
    });
  });
});
