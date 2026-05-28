import { asc, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import AgentVersionModel from "./agent-version";

vi.mock("@/observability", () => ({
  initializeObservabilityMetrics: vi.fn(),
  metrics: {
    llm: { initializeMetrics: vi.fn() },
    mcp: { initializeMcpMetrics: vi.fn() },
    agentExecution: { initializeAgentExecutionMetrics: vi.fn() },
  },
}));

// ===
// Model-level tests: AgentVersionModel.record() in isolation
// ===

describe("AgentVersionModel.record()", () => {
  test("creates v1 when no prior version exists", async ({
    makeAgent,
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    const user = await makeUser();

    const result = await AgentVersionModel.record({
      agentId: agent.id,
      organizationId: org.id,
      systemPrompt: "Hello world",
      source: "create",
      userId: user.id,
      userName: user.name,
    });

    expect(result).not.toBeNull();
    expect(result?.versionNumber).toBe(1);

    const latest = await AgentVersionModel.getLatest(agent.id);
    expect(latest).not.toBeNull();
    expect(latest?.versionNumber).toBe(1);
    expect(latest?.source).toBe("create");
    expect((latest?.snapshot as { systemPrompt: string }).systemPrompt).toBe(
      "Hello world",
    );
  });

  test("deduplicates: identical prompt content does not create a new row", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    const user = await makeUser();

    await AgentVersionModel.record({
      agentId: agent.id,
      organizationId: org.id,
      systemPrompt: "Same prompt",
      source: "create",
      userId: user.id,
      userName: user.name,
    });

    const dedupResult = await AgentVersionModel.record({
      agentId: agent.id,
      organizationId: org.id,
      systemPrompt: "Same prompt",
      source: "update",
      userId: user.id,
      userName: user.name,
    });

    expect(dedupResult).toBeNull();

    const rows = await db
      .select()
      .from(schema.agentVersionsTable)
      .where(eq(schema.agentVersionsTable.agentId, agent.id));
    expect(rows).toHaveLength(1);
  });

  test("creates a new version when prompt changes", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    const user = await makeUser();

    await AgentVersionModel.record({
      agentId: agent.id,
      organizationId: org.id,
      systemPrompt: "Prompt A",
      source: "create",
      userId: user.id,
      userName: user.name,
    });

    const v2 = await AgentVersionModel.record({
      agentId: agent.id,
      organizationId: org.id,
      systemPrompt: "Prompt B",
      source: "update",
      userId: user.id,
      userName: user.name,
    });

    expect(v2).not.toBeNull();
    expect(v2?.versionNumber).toBe(2);

    const latest = await AgentVersionModel.getLatest(agent.id);
    expect((latest?.snapshot as { systemPrompt: string }).systemPrompt).toBe(
      "Prompt B",
    );
    expect(latest?.source).toBe("update");
  });

  test("monotonically increments version_number across sequential updates", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    const user = await makeUser();

    const r1 = await AgentVersionModel.record({
      agentId: agent.id,
      organizationId: org.id,
      systemPrompt: "Prompt A",
      source: "create",
      userId: user.id,
      userName: user.name,
    });
    const r2 = await AgentVersionModel.record({
      agentId: agent.id,
      organizationId: org.id,
      systemPrompt: "Prompt B",
      source: "update",
      userId: user.id,
      userName: user.name,
    });
    const r3 = await AgentVersionModel.record({
      agentId: agent.id,
      organizationId: org.id,
      systemPrompt: "Prompt C",
      source: "update",
      userId: user.id,
      userName: user.name,
    });

    expect(r1?.versionNumber).toBe(1);
    expect(r2?.versionNumber).toBe(2);
    expect(r3?.versionNumber).toBe(3);

    const rows = await db
      .select()
      .from(schema.agentVersionsTable)
      .where(eq(schema.agentVersionsTable.agentId, agent.id))
      .orderBy(asc(schema.agentVersionsTable.versionNumber));
    expect(rows).toHaveLength(3);
    expect(rows[0].versionNumber).toBe(1);
    expect(rows[1].versionNumber).toBe(2);
    expect(rows[2].versionNumber).toBe(3);
  });

  test("stores createdBy and createdByName from the user", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    const user = await makeUser({ name: "Alice Tester" });

    await AgentVersionModel.record({
      agentId: agent.id,
      organizationId: org.id,
      systemPrompt: "A prompt",
      source: "create",
      userId: user.id,
      userName: user.name,
    });

    const latest = await AgentVersionModel.getLatest(agent.id);
    expect(latest?.createdBy).toBe(user.id);
    expect(latest?.createdByName).toBe("Alice Tester");
  });
});

// ===
// Route integration tests: verify the route hook fires (or not) correctly
// ===

describe("route hook integration", () => {
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

    const { default: agentRoutes } = await import("../routes/agent");
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("POST /api/agents with non-null systemPrompt writes v1 with source='create'", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: `Test Agent ${crypto.randomUUID().slice(0, 8)}`,
        agentType: "agent",
        scope: "personal",
        teams: [],
        systemPrompt: "You are a helpful assistant",
      },
    });

    expect(response.statusCode).toBe(200);
    const agent = response.json();

    const latest = await AgentVersionModel.getLatest(agent.id);
    expect(latest).not.toBeNull();
    expect(latest?.versionNumber).toBe(1);
    expect(latest?.source).toBe("create");
    expect((latest?.snapshot as { systemPrompt: string }).systemPrompt).toBe(
      "You are a helpful assistant",
    );
  });

  test("POST /api/agents with null systemPrompt writes no version row", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: `MCP Gateway ${crypto.randomUUID().slice(0, 8)}`,
        agentType: "mcp_gateway",
        scope: "personal",
        teams: [],
      },
    });

    expect(response.statusCode).toBe(200);
    const agent = response.json();

    const latest = await AgentVersionModel.getLatest(agent.id);
    expect(latest).toBeNull();
  });

  test("PUT /api/agents/:id with changed systemPrompt writes a new version", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: `Test Agent ${crypto.randomUUID().slice(0, 8)}`,
        agentType: "agent",
        scope: "personal",
        teams: [],
        systemPrompt: "Original prompt",
      },
    });
    const agent = createResponse.json();

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { systemPrompt: "Updated prompt" },
    });
    expect(updateResponse.statusCode).toBe(200);

    const latest = await AgentVersionModel.getLatest(agent.id);
    expect(latest?.versionNumber).toBe(2);
    expect(latest?.source).toBe("update");
    expect((latest?.snapshot as { systemPrompt: string }).systemPrompt).toBe(
      "Updated prompt",
    );
  });

  test("PUT /api/agents/:id with only name change writes no new version", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: `Test Agent ${crypto.randomUUID().slice(0, 8)}`,
        agentType: "agent",
        scope: "personal",
        teams: [],
        systemPrompt: "Original prompt",
      },
    });
    const agent = createResponse.json();

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { name: "Renamed Agent" },
    });
    expect(updateResponse.statusCode).toBe(200);

    const rows = await db
      .select()
      .from(schema.agentVersionsTable)
      .where(eq(schema.agentVersionsTable.agentId, agent.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].versionNumber).toBe(1);
    expect(rows[0].source).toBe("create");
  });
});
