import { type Mock, vi } from "vitest";
import { getAgentTypePermissionChecker } from "@/auth";
import { AgentModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

const mockGetAgentTypePermissionChecker = getAgentTypePermissionChecker as Mock;

describe("agent version routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  function mockChecker(params: { canRead: boolean; isAdmin: boolean }) {
    mockGetAgentTypePermissionChecker.mockResolvedValue({
      require: vi.fn().mockImplementation(() => {
        if (!params.canRead) throw new Error("denied");
      }),
      isAdmin: vi.fn().mockReturnValue(params.isAdmin),
    });
  }

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId);

    mockChecker({ canRead: true, isAdmin: true });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: agentRoutes } = await import("./agent");
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe("GET /api/agents/:id/versions", () => {
    test("lists version metadata newest first, without the snapshot", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ organizationId });
      await AgentModel.update(agent.id, { description: "second draft" });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });
      expect(response.statusCode).toBe(200);

      const { data, pagination } = response.json();
      expect(pagination.total).toBe(2);
      expect(data.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      // the list is a metadata projection; the snapshot stays on get-one
      expect(data[0]).not.toHaveProperty("snapshot");
      expect(data[0].contentHash).toEqual(expect.any(String));
    });

    test("paginates with limit and offset", async ({ makeAgent }) => {
      const agent = await makeAgent({ organizationId });
      await AgentModel.update(agent.id, { description: "two" });
      await AgentModel.update(agent.id, { description: "three" });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions?limit=2&offset=2`,
      });
      expect(response.statusCode).toBe(200);

      const { data, pagination } = response.json();
      expect(pagination.total).toBe(3);
      expect(data.map((v: { version: number }) => v.version)).toEqual([1]);
    });

    test("a soft-deleted agent's history is unreachable", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ organizationId });
      await AgentModel.delete(agent.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });
      expect(response.statusCode).toBe(404);
    });

    test("an agent of another organization is 404", async ({ makeAgent }) => {
      const foreignAgent = await makeAgent();

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${foreignAgent.id}/versions`,
      });
      expect(response.statusCode).toBe(404);
    });

    test("missing type read permission is 404, not 403", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ organizationId });
      mockChecker({ canRead: false, isAdmin: false });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });
      expect(response.statusCode).toBe(404);
    });

    test("a non-admin cannot read history of an invisible agent", async ({
      makeAgent,
      makeUser,
    }) => {
      const author = await makeUser();
      // personal agent of someone else: type-level read passes, the
      // team/author-filtered re-fetch does not
      const agent = await makeAgent({
        organizationId,
        scope: "personal",
        authorId: author.id,
      });
      mockChecker({ canRead: true, isAdmin: false });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });
      expect(response.statusCode).toBe(404);
    });

    test("a non-admin can read history of a visible agent", async ({
      makeAgent,
    }) => {
      // org-scoped agent: type-level read passes and the real team/author
      // filter grants visibility to any org member
      const agent = await makeAgent({ organizationId });
      mockChecker({ canRead: true, isAdmin: false });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().pagination.total).toBe(1);
    });
  });

  describe("GET /api/agents/:id/versions/:version", () => {
    test("returns the full config snapshot", async ({ makeAgent }) => {
      const agent = await makeAgent({ organizationId });
      await AgentModel.update(agent.id, { description: "second draft" });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions/2`,
      });
      expect(response.statusCode).toBe(200);

      const version = response.json();
      expect(version.version).toBe(2);
      expect(version.snapshot.name).toBe(agent.name);
      expect(version.snapshot.description).toBe("second draft");
    });

    test("a non-admin can read a version of a visible agent", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ organizationId });
      mockChecker({ canRead: true, isAdmin: false });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions/1`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().version).toBe(1);
    });

    test("a version that does not exist is 404", async ({ makeAgent }) => {
      const agent = await makeAgent({ organizationId });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions/99`,
      });
      expect(response.statusCode).toBe(404);
    });

    test("a version beyond the int4 range is 400", async ({ makeAgent }) => {
      const agent = await makeAgent({ organizationId });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions/3000000000`,
      });
      expect(response.statusCode).toBe(400);
    });

    test("a soft-deleted agent's version is unreachable", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ organizationId });
      await AgentModel.delete(agent.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions/1`,
      });
      expect(response.statusCode).toBe(404);
    });

    test("missing type read permission is 404, not 403", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ organizationId });
      mockChecker({ canRead: false, isAdmin: false });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions/1`,
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
