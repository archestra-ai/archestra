import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/observability", () => ({
  initializeObservabilityMetrics: vi.fn(),
  metrics: {
    llm: { initializeMetrics: vi.fn() },
    mcp: { initializeMcpMetrics: vi.fn() },
    agentExecution: { initializeAgentExecutionMetrics: vi.fn() },
  },
}));

describe("agent-version routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { user: User; organizationId: string }
      ).user = user;
      (
        request as typeof request & { user: User; organizationId: string }
      ).organizationId = organizationId;
    });

    const [{ default: agentRoutes }, { default: agentVersionRoutes }] =
      await Promise.all([import("./agent"), import("./agent-version")]);
    await app.register(agentRoutes);
    await app.register(agentVersionRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  async function createAgentWithPrompt(systemPrompt: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: `Agent ${crypto.randomUUID().slice(0, 8)}`,
        agentType: "agent",
        scope: "personal",
        teams: [],
        systemPrompt,
      },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { id: string; systemPrompt: string };
  }

  // ===
  // GET /api/agents/:id/versions
  // ===

  describe("GET /api/agents/:id/versions", () => {
    test("returns empty list when no versions exist", async ({ makeAgent }) => {
      const agent = await makeAgent({ organizationId, agentType: "agent" });

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    test("returns versions in descending version_number order", async () => {
      const agent = await createAgentWithPrompt("Prompt A");

      await app.inject({
        method: "PUT",
        url: `/api/agents/${agent.id}`,
        payload: { systemPrompt: "Prompt B" },
      });
      await app.inject({
        method: "PUT",
        url: `/api/agents/${agent.id}`,
        payload: { systemPrompt: "Prompt C" },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(3);
      expect(body.data).toHaveLength(3);
      expect(body.data[0].versionNumber).toBe(3);
      expect(body.data[1].versionNumber).toBe(2);
      expect(body.data[2].versionNumber).toBe(1);
    });

    test("paginates with limit and offset", async () => {
      const agent = await createAgentWithPrompt("Prompt A");
      await app.inject({
        method: "PUT",
        url: `/api/agents/${agent.id}`,
        payload: { systemPrompt: "Prompt B" },
      });
      await app.inject({
        method: "PUT",
        url: `/api/agents/${agent.id}`,
        payload: { systemPrompt: "Prompt C" },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions?limit=2&offset=0`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(3);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].versionNumber).toBe(3);
      expect(body.data[1].versionNumber).toBe(2);
    });

    test("includes promptPreview (first 100 chars)", async () => {
      const longPrompt = "A".repeat(200);
      const agent = await createAgentWithPrompt(longPrompt);

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data[0].promptPreview).toBe("A".repeat(100));
    });

    test("returns 404 for an agent in a different organization", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();
      const agent = await makeAgent({
        organizationId: otherOrg.id,
        agentType: "agent",
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ===
  // GET /api/agents/:id/versions/:versionId
  // ===

  describe("GET /api/agents/:id/versions/:versionId", () => {
    test("returns the full snapshot for a valid version", async () => {
      const agent = await createAgentWithPrompt("You are helpful.");

      const listRes = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });
      const { data } = listRes.json();
      const versionId = data[0].id;

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions/${versionId}`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(versionId);
      expect(body.agentId).toBe(agent.id);
      expect(body.versionNumber).toBe(1);
      expect(body.snapshot.version).toBe("1");
      expect(body.snapshot.systemPrompt).toBe("You are helpful.");
      expect(body.source).toBe("create");
    });

    test("returns 404 when versionId belongs to a different agent", async ({
      makeAgent,
    }) => {
      const agent1 = await createAgentWithPrompt("Prompt for agent 1");
      const agent2 = await makeAgent({ organizationId, agentType: "agent" });

      const listRes = await app.inject({
        method: "GET",
        url: `/api/agents/${agent1.id}/versions`,
      });
      const versionId = listRes.json().data[0].id;

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${agent2.id}/versions/${versionId}`,
      });

      expect(res.statusCode).toBe(404);
    });

    test("returns 404 for a non-existent versionId", async () => {
      const agent = await createAgentWithPrompt("Prompt");
      const fakeId = crypto.randomUUID();

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions/${fakeId}`,
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ===
  // GET /api/agents/:id/versions/:versionId/diff
  // ===

  describe("GET /api/agents/:id/versions/:versionId/diff", () => {
    test("returns changed=true with both prompts when versions differ", async () => {
      const agent = await createAgentWithPrompt("Prompt A");
      await app.inject({
        method: "PUT",
        url: `/api/agents/${agent.id}`,
        payload: { systemPrompt: "Prompt B" },
      });

      const listRes = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });
      const { data } = listRes.json();
      const v1Id = data.find(
        (v: { versionNumber: number }) => v.versionNumber === 1,
      ).id;
      const v2Id = data.find(
        (v: { versionNumber: number }) => v.versionNumber === 2,
      ).id;

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions/${v1Id}/diff?against=${v2Id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.changed).toBe(true);
      expect(body.base.systemPrompt).toBe("Prompt A");
      expect(body.base.versionNumber).toBe(1);
      expect(body.target.systemPrompt).toBe("Prompt B");
      expect(body.target.versionNumber).toBe(2);
      expect(body.target.label).toBe("v2");
    });

    test("returns changed=false when both versions have the same prompt", async () => {
      const agent = await createAgentWithPrompt("Same prompt");

      const listRes = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });
      const v1Id = listRes.json().data[0].id;

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions/${v1Id}/diff?against=${v1Id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.changed).toBe(false);
    });

    test("diffs against current with against=current", async () => {
      const agent = await createAgentWithPrompt("Prompt A");
      await app.inject({
        method: "PUT",
        url: `/api/agents/${agent.id}`,
        payload: { systemPrompt: "Prompt B (current)" },
      });

      const listRes = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });
      const v1Id = listRes
        .json()
        .data.find((v: { versionNumber: number }) => v.versionNumber === 1).id;

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions/${v1Id}/diff?against=current`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.changed).toBe(true);
      expect(body.base.systemPrompt).toBe("Prompt A");
      expect(body.target.systemPrompt).toBe("Prompt B (current)");
      expect(body.target.versionNumber).toBeNull();
      expect(body.target.label).toBe("current");
    });

    test("returns 404 when target version belongs to a different agent", async () => {
      const agent1 = await createAgentWithPrompt("Agent 1 prompt");
      const agent2 = await createAgentWithPrompt("Agent 2 prompt");

      const a1List = await app.inject({
        method: "GET",
        url: `/api/agents/${agent1.id}/versions`,
      });
      const a2List = await app.inject({
        method: "GET",
        url: `/api/agents/${agent2.id}/versions`,
      });

      const v1Id = a1List.json().data[0].id;
      const v2Id = a2List.json().data[0].id;

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${agent1.id}/versions/${v1Id}/diff?against=${v2Id}`,
      });

      expect(res.statusCode).toBe(404);
    });

    test("returns 400 when against is neither 'current' nor a valid UUID", async () => {
      const agent = await createAgentWithPrompt("Prompt A");

      const listRes = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });
      const v1Id = listRes.json().data[0].id;

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions/${v1Id}/diff?against=not-a-uuid`,
      });

      // Rejected at querystring validation rather than reaching a uuid column
      // lookup (which would surface as a 500).
      expect(res.statusCode).toBe(400);
    });
  });

  // ===
  // POST /api/agents/:id/versions/:versionId/restore
  // ===

  describe("POST /api/agents/:id/versions/:versionId/restore", () => {
    test("restores agent prompt to a prior version and writes a new restore row", async () => {
      const agent = await createAgentWithPrompt("Prompt A");
      await app.inject({
        method: "PUT",
        url: `/api/agents/${agent.id}`,
        payload: { systemPrompt: "Prompt B" },
      });

      const listRes = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });
      const v1Id = listRes
        .json()
        .data.find((v: { versionNumber: number }) => v.versionNumber === 1).id;

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/versions/${v1Id}/restore`,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      // Agent prompt is reverted to v1
      expect(body.agent.systemPrompt).toBe("Prompt A");

      // A new version row is created with source='restore'
      expect(body.restoredVersion).not.toBeNull();
      expect(body.restoredVersion.source).toBe("restore");
      expect(body.restoredVersion.versionNumber).toBe(3);
    });

    test("after restore, listing versions shows the new restore entry at the top", async () => {
      const agent = await createAgentWithPrompt("Prompt A");
      await app.inject({
        method: "PUT",
        url: `/api/agents/${agent.id}`,
        payload: { systemPrompt: "Prompt B" },
      });

      const listRes = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });
      const v1Id = listRes
        .json()
        .data.find((v: { versionNumber: number }) => v.versionNumber === 1).id;

      await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/versions/${v1Id}/restore`,
        payload: {},
      });

      const afterRes = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });

      const versions = afterRes.json().data;
      expect(versions[0].source).toBe("restore");
      expect(versions[0].versionNumber).toBe(3);
      expect(afterRes.json().total).toBe(3);
    });

    test("restoring the currently-live prompt is a no-op: returns agent but restoredVersion=null", async () => {
      const agent = await createAgentWithPrompt("Prompt A");

      const listRes = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });
      const v1Id = listRes.json().data[0].id;

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/versions/${v1Id}/restore`,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.agent.systemPrompt).toBe("Prompt A");
      // Dedup: prompt is already live, so no new version row
      expect(body.restoredVersion).toBeNull();

      // Version count must not have grown
      const afterListRes = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });
      expect(afterListRes.json().total).toBe(1);
    });

    test("returns 404 when versionId belongs to a different agent", async () => {
      const agent1 = await createAgentWithPrompt("Agent 1 prompt");
      const agent2 = await createAgentWithPrompt("Agent 2 prompt");

      const a2List = await app.inject({
        method: "GET",
        url: `/api/agents/${agent2.id}/versions`,
      });
      const a2v1Id = a2List.json().data[0].id;

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${agent1.id}/versions/${a2v1Id}/restore`,
        payload: {},
      });

      expect(res.statusCode).toBe(404);
    });

    test("returns 404 when caller lacks update permission (cross-org agent)", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();
      const agent = await makeAgent({
        organizationId: otherOrg.id,
        agentType: "agent",
      });
      const fakeVersionId = crypto.randomUUID();

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/versions/${fakeVersionId}/restore`,
        payload: {},
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ===
  // Permission check
  // ===

  describe("permission checks", () => {
    test("GET /versions returns 404 when caller lacks read permission", async ({
      makeAgent,
      makeOrganization,
    }) => {
      // Cross-org agent: the caller's organizationId won't match, so 404.
      const otherOrg = await makeOrganization();
      const agent = await makeAgent({
        organizationId: otherOrg.id,
        agentType: "agent",
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/versions`,
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
