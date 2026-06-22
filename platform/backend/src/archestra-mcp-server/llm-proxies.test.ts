// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import { vi } from "vitest";
import { fastifyAuthPlugin, loopbackGateway } from "@/auth";
import { AgentModel } from "@/models";
import agentRoutes from "@/routes/agent";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";
import { ARCHESTRA_API_DEPRECATION_NOTE } from "./helpers";

// The loopback PUT /api/agents/:id route touches Prometheus exemplar counters,
// which require an OpenMetrics registry the test process does not provide. Stub
// the metrics process boundary the same way the canonical agent route test does
// (src/routes/agent.test.ts) — the tool → loopback → route → DB path stays real.
vi.mock("@/observability", () => ({
  initializeObservabilityMetrics: vi.fn(),
  metrics: {
    llm: { initializeMetrics: vi.fn() },
    mcp: { initializeMcpMetrics: vi.fn() },
    agentExecution: { initializeAgentExecutionMetrics: vi.fn() },
  },
}));

describe("llm proxy tool execution", () => {
  let app: FastifyInstanceWithZod;
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });
    testAgent = await makeAgent({
      name: "Test Agent",
      organizationId: organization.id,
    });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: user.id,
      organizationId: organization.id,
    };

    app = createFastifyInstance();
    await app.register(fastifyAuthPlugin);
    await app.register(agentRoutes);
    loopbackGateway.setServer(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test("create_llm_proxy creates a proxy successfully", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_llm_proxy`,
      { name: "Test LLM Proxy" },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect((result.content[0] as any).text).toContain(
      "Successfully created llm proxy",
    );
    // create_llm_proxy is a deprecated platform tool, so the note is appended.
    expect((result.content.at(-1) as any).text).toContain(
      "Deprecated: prefer the archestra__api tool",
    );
  });

  test("edit_llm_proxy updates an llm proxy successfully", async ({
    makeAgent,
  }) => {
    const organizationId = mockContext.organizationId;
    if (!organizationId) {
      throw new Error("Expected organizationId in test context");
    }

    const llmProxy = await makeAgent({
      name: "Original LLM Proxy",
      agentType: "llm_proxy",
      organizationId,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_llm_proxy`,
      {
        id: llmProxy.id,
        name: "Updated LLM Proxy",
        labels: [{ key: "team", value: "platform" }],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect(result.structuredContent?.status).toBe(200);

    const updated = await AgentModel.findById(
      llmProxy.id,
      mockContext.userId,
      true,
    );
    expect(updated?.name).toBe("Updated LLM Proxy");
    expect(updated?.labels).toContainEqual(
      expect.objectContaining({ key: "team", value: "platform" }),
    );

    expect((result.content.at(-1) as any).text).toBe(
      ARCHESTRA_API_DEPRECATION_NOTE,
    );
    expect(ARCHESTRA_API_DEPRECATION_NOTE).toContain(
      "Deprecated: prefer the archestra__api tool",
    );
  });

  test("edit_llm_proxy on a non-existent id returns a 404 error result", async () => {
    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_llm_proxy`,
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Does Not Matter",
      },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.status).toBe(404);
    expect((result.content.at(-1) as any).text).toBe(
      ARCHESTRA_API_DEPRECATION_NOTE,
    );
  });

  test("edit_llm_proxy refuses to edit a non-proxy agent", async ({
    makeAgent,
  }) => {
    const organizationId = mockContext.organizationId;
    if (!organizationId) {
      throw new Error("Expected organizationId in test context");
    }

    const gateway = await makeAgent({
      name: "A Gateway",
      agentType: "mcp_gateway",
      organizationId,
    });

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_llm_proxy`,
      { id: gateway.id, name: "Should Not Apply" },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("not a llm proxy");

    // the wrong-type edit was rejected before any write
    const unchanged = await AgentModel.findById(
      gateway.id,
      mockContext.userId,
      true,
    );
    expect(unchanged?.name).toBe("A Gateway");
  });
});
