import { BUILT_IN_AGENT_IDS } from "@shared";
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

describe("agent routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    user = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId, { role: "admin" });

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

  describe("POST /api/agents", () => {
    test("should create a new agent", async () => {
      const name = `Test Agent ${crypto.randomUUID().slice(0, 8)}`;

      const response = await app.inject({
        method: "POST",
        url: "/api/agents",
        payload: {
          name,
          scope: "personal",
          teams: [],
        },
      });

      expect(response.statusCode).toBe(200);
      const agent = response.json();
      expect(agent).toHaveProperty("id");
      expect(agent.name).toBe(name);
      expect(Array.isArray(agent.tools)).toBe(true);
      expect(Array.isArray(agent.teams)).toBe(true);
    });

    test("should create agent with suggestedPrompts", async () => {
      const name = `Agent With Suggestions ${crypto.randomUUID().slice(0, 8)}`;

      const response = await app.inject({
        method: "POST",
        url: "/api/agents",
        payload: {
          name,
          agentType: "agent",
          scope: "personal",
          teams: [],
          suggestedPrompts: [
            { summaryTitle: "Quick start", prompt: "Get me started" },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const agent = response.json();
      expect(agent.suggestedPrompts).toHaveLength(1);
      expect(agent.suggestedPrompts[0].summaryTitle).toBe("Quick start");
      expect(agent.suggestedPrompts[0].prompt).toBe("Get me started");
    });
  });

  describe("GET /api/agents/:id", () => {
    test("should get agent by ID", async ({ makeAgent }) => {
      const name = `Agent for Get By ID ${crypto.randomUUID().slice(0, 8)}`;
      const created = await makeAgent({
        name,
        organizationId,
        scope: "personal",
        authorId: user.id,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${created.id}`,
      });

      expect(response.statusCode).toBe(200);
      const agent = response.json();
      expect(agent.id).toBe(created.id);
      expect(agent.name).toBe(name);
      expect(agent).toHaveProperty("tools");
      expect(agent).toHaveProperty("teams");
    });

    test("should return 404 for non-existent agent", async () => {
      const fakeId = crypto.randomUUID();

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${fakeId}`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("PUT /api/agents/:id", () => {
    test("should update an agent name", async ({ makeAgent }) => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const created = await makeAgent({
        name: `Agent for Update ${suffix}`,
        organizationId,
        scope: "personal",
        authorId: user.id,
      });

      const updatedName = `Updated Agent ${suffix}`;
      const response = await app.inject({
        method: "PUT",
        url: `/api/agents/${created.id}`,
        payload: { name: updatedName },
      });

      expect(response.statusCode).toBe(200);
      const agent = response.json();
      expect(agent).toHaveProperty("id");
      expect(agent.name).toBe(updatedName);
    });

    test("should update systemPrompt and suggestedPrompts", async ({
      makeAgent,
    }) => {
      const created = await makeAgent({
        name: `Agent Prompt Test ${crypto.randomUUID().slice(0, 8)}`,
        organizationId,
        scope: "personal",
        authorId: user.id,
        agentType: "agent",
      });

      // Set prompts
      const setResponse = await app.inject({
        method: "PUT",
        url: `/api/agents/${created.id}`,
        payload: {
          systemPrompt: "You are a test assistant",
          suggestedPrompts: [
            { summaryTitle: "Hello", prompt: "Say hello to me" },
            { summaryTitle: "Help", prompt: "Help me with something" },
          ],
        },
      });

      expect(setResponse.statusCode).toBe(200);
      const withPrompts = setResponse.json();
      expect(withPrompts.systemPrompt).toBe("You are a test assistant");
      expect(withPrompts.suggestedPrompts).toHaveLength(2);
      expect(withPrompts.suggestedPrompts[0].summaryTitle).toBe("Hello");
      expect(withPrompts.suggestedPrompts[0].prompt).toBe("Say hello to me");
      expect(withPrompts.suggestedPrompts[1].summaryTitle).toBe("Help");

      // Update suggested prompts (replaces)
      const updateResponse = await app.inject({
        method: "PUT",
        url: `/api/agents/${created.id}`,
        payload: {
          suggestedPrompts: [
            { summaryTitle: "New prompt", prompt: "A new prompt" },
          ],
        },
      });

      expect(updateResponse.statusCode).toBe(200);
      const updated = updateResponse.json();
      expect(updated.suggestedPrompts).toHaveLength(1);
      expect(updated.suggestedPrompts[0].summaryTitle).toBe("New prompt");

      // Clear suggested prompts
      const clearResponse = await app.inject({
        method: "PUT",
        url: `/api/agents/${created.id}`,
        payload: {
          systemPrompt: null,
          suggestedPrompts: [],
        },
      });

      expect(clearResponse.statusCode).toBe(200);
      const cleared = clearResponse.json();
      expect(cleared.systemPrompt).toBeNull();
      expect(cleared.suggestedPrompts).toHaveLength(0);

      // Verify persistence via GET
      const getResponse = await app.inject({
        method: "GET",
        url: `/api/agents/${created.id}`,
      });

      expect(getResponse.statusCode).toBe(200);
      const fetched = getResponse.json();
      expect(fetched.systemPrompt).toBeNull();
      expect(fetched.suggestedPrompts).toHaveLength(0);
    });
  });

  describe("DELETE /api/agents/:id", () => {
    test("should delete an agent", async ({ makeAgent }) => {
      const created = await makeAgent({
        name: `Agent for Delete ${crypto.randomUUID().slice(0, 8)}`,
        organizationId,
        scope: "personal",
        authorId: user.id,
      });

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/agents/${created.id}`,
      });

      if (deleteResponse.statusCode !== 200) {
      }
      expect(deleteResponse.statusCode).toBe(200);
      const body = deleteResponse.json();
      expect(body).toHaveProperty("success");
      expect(body.success).toBe(true);

      // Verify agent is deleted
      const getResponse = await app.inject({
        method: "GET",
        url: `/api/agents/${created.id}`,
      });

      expect(getResponse.statusCode).toBe(404);
    });
  });

  describe("GET /api/agents (paginated)", () => {
    test("should return paginated agents", async ({ makeAgent }) => {
      const suffix = crypto.randomUUID().slice(0, 8);
      await makeAgent({
        name: `Paginated Agent ${suffix}`,
        organizationId,
        scope: "org",
        authorId: user.id,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents?limit=10&offset=0&sortBy=name&sortDirection=asc&name=${suffix}`,
      });

      expect(response.statusCode).toBe(200);
      const result = response.json();
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data[0].name).toContain(suffix);
    });

    test("should return personal agent first in paginated list", async ({
      makeAgent,
    }) => {
      const suffix = crypto.randomUUID().slice(0, 8);

      // Create shared agent with alphabetically earlier name
      await makeAgent({
        name: `Alpha Shared ${suffix}`,
        organizationId,
        scope: "org",
        authorId: user.id,
      });

      // Create personal agent with alphabetically later name
      await makeAgent({
        name: `Zulu Personal ${suffix}`,
        organizationId,
        scope: "personal",
        authorId: user.id,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents?limit=10&offset=0&sortBy=name&sortDirection=asc&name=${suffix}`,
      });

      expect(response.statusCode).toBe(200);
      const result = response.json();
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data[0].scope).toBe("personal");
      expect(result.data[0].name).toContain("Zulu Personal");
    });
  });

  describe("GET /api/agents/all", () => {
    test("should exclude built-in agents when excludeBuiltIn=true", async ({
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      // Ensure at least one non-built-in agent exists
      const agent = await makeAgent({
        name: `Non Built-in ${crypto.randomUUID().slice(0, 8)}`,
        organizationId,
        scope: "org",
        authorId: user.id,
      });
      await seedAndAssignArchestraTools(agent.id);

      const response = await app.inject({
        method: "GET",
        url: "/api/agents/all?excludeBuiltIn=true",
      });

      expect(response.statusCode).toBe(200);
      const agents = response.json();
      expect(Array.isArray(agents)).toBe(true);
      expect(agents.length).toBeGreaterThan(0);

      const builtInAgents = agents.filter(
        (a: { builtInAgentConfig?: unknown }) => a.builtInAgentConfig != null,
      );
      expect(builtInAgents).toHaveLength(0);
    });

    test("should include built-in agents when excludeBuiltIn is not set", async ({
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      // Create a built-in agent
      await makeAgent({
        name: "Policy Configuration Subagent",
        organizationId,
        agentType: "agent",
        scope: "org",
        authorId: user.id,
        builtInAgentConfig: {
          name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
          autoConfigureOnToolDiscovery: true,
        },
      });
      // Also create a regular agent with tools
      const agent = await makeAgent({
        name: `Seed Target ${crypto.randomUUID().slice(0, 8)}`,
        organizationId,
        scope: "org",
        authorId: user.id,
      });
      await seedAndAssignArchestraTools(agent.id);

      const response = await app.inject({
        method: "GET",
        url: "/api/agents/all",
      });

      expect(response.statusCode).toBe(200);
      const agents = response.json();
      expect(Array.isArray(agents)).toBe(true);
      expect(agents.length).toBeGreaterThan(0);

      const builtInAgents = agents.filter(
        (a: { builtInAgentConfig?: unknown }) => a.builtInAgentConfig != null,
      );
      expect(builtInAgents.length).toBeGreaterThan(0);
    });
  });

  describe("GET /api/mcp-gateways/default", () => {
    test("should get default MCP gateway", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/mcp-gateways/default",
      });

      expect(response.statusCode).toBe(200);
      const agent = response.json();
      expect(agent).toHaveProperty("id");
      expect(agent).toHaveProperty("name");
      expect(agent.isDefault).toBe(true);
      expect(Array.isArray(agent.tools)).toBe(true);
      expect(Array.isArray(agent.teams)).toBe(true);
    });
  });
});
