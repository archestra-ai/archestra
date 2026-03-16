import { expect, test } from "./fixtures";

test.describe("Agents API CRUD", () => {
  test("should get all agents excluding built-in when excludeBuiltIn=true", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/agents/all?excludeBuiltIn=true",
    });
    const agents = await response.json();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThan(0);

    const builtInAgents = agents.filter(
      (a: { builtInAgentConfig?: unknown }) => a.builtInAgentConfig != null,
    );
    expect(builtInAgents).toHaveLength(0);
  });

  test("should include built-in agents when excludeBuiltIn is not set", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/agents/all",
    });
    const agents = await response.json();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThan(0);

    // Without excludeBuiltIn, built-in agents should be included
    const builtInAgents = agents.filter(
      (a: { builtInAgentConfig?: unknown }) => a.builtInAgentConfig != null,
    );
    expect(builtInAgents.length).toBeGreaterThan(0);
  });

  test("should create a new agent", async ({ request, createAgent }) => {
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const agentName = `Test Agent for Integration ${uniqueSuffix}`;

    const response = await createAgent(request, agentName, "personal");
    const agent = await response.json();

    expect(agent).toHaveProperty("id");
    expect(agent.name).toBe(agentName);
    expect(Array.isArray(agent.tools)).toBe(true);
    expect(Array.isArray(agent.teams)).toBe(true);
  });

  test("should return the current user's personal agent first in paginated agent lists", async ({
    request,
    createAgent,
    deleteAgent,
    makeApiRequest,
  }) => {
    let personalAgentId: string | null = null;
    let sharedAgentId: string | null = null;

    try {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const sharedResponse = await createAgent(
        request,
        `Alpha Shared Agent ${uniqueSuffix}`,
        "org",
      );
      const sharedAgent = await sharedResponse.json();
      sharedAgentId = sharedAgent.id;

      const personalResponse = await createAgent(
        request,
        `Zulu Personal Agent ${uniqueSuffix}`,
        "personal",
      );
      const personalAgent = await personalResponse.json();
      personalAgentId = personalAgent.id;

      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/agents?limit=10&offset=0&sortBy=name&sortDirection=asc&name=${uniqueSuffix}`,
      });
      const agents = await response.json();

      expect(Array.isArray(agents.data)).toBe(true);
      expect(agents.data[0].id).toBe(personalAgent.id);
      expect(agents.data[0].scope).toBe("personal");
    } finally {
      if (personalAgentId) {
        await deleteAgent(request, personalAgentId);
      }
      if (sharedAgentId) {
        await deleteAgent(request, sharedAgentId);
      }
    }
  });

  test("should get agent by ID", async ({
    request,
    createAgent,
    makeApiRequest,
  }) => {
    // Create an agent first
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const agentName = `Agent for Get By ID Test ${uniqueSuffix}`;
    const createResponse = await createAgent(request, agentName, "personal");
    const createdAgent = await createResponse.json();

    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/agents/${createdAgent.id}`,
    });
    const agent = await response.json();

    expect(agent.id).toBe(createdAgent.id);
    expect(agent.name).toBe(agentName);
    expect(agent).toHaveProperty("tools");
    expect(agent).toHaveProperty("teams");
  });

  test("should update an agent", async ({
    request,
    createAgent,
    makeApiRequest,
  }) => {
    // Create an agent first
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const createResponse = await createAgent(
      request,
      `Agent for Update Test ${uniqueSuffix}`,
      "personal",
    );
    const createdAgent = await createResponse.json();

    const updatedName = `Updated Test Agent ${uniqueSuffix}`;

    const updateResponse = await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${createdAgent.id}`,
      data: { name: updatedName },
    });
    const updatedAgent = await updateResponse.json();

    expect(updatedAgent).toHaveProperty("id");
    expect(updatedAgent.name).toBe(updatedName);
  });

  test("should update systemPrompt and suggestedPrompts", async ({
    request,
    createAgent,
    makeApiRequest,
  }) => {
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const createResponse = await createAgent(
      request,
      `Agent Prompt Test ${uniqueSuffix}`,
      "personal",
    );
    const createdAgent = await createResponse.json();

    // Set agentType to 'agent' and set prompts with suggested prompts
    const setResponse = await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${createdAgent.id}`,
      data: {
        agentType: "agent",
        systemPrompt: "You are a test assistant",
        suggestedPrompts: [
          { summaryTitle: "Hello", prompt: "Say hello to me" },
          { summaryTitle: "Help", prompt: "Help me with something" },
        ],
      },
    });
    const withPrompts = await setResponse.json();
    expect(withPrompts.systemPrompt).toBe("You are a test assistant");
    expect(withPrompts.suggestedPrompts).toHaveLength(2);
    expect(withPrompts.suggestedPrompts[0].summaryTitle).toBe("Hello");
    expect(withPrompts.suggestedPrompts[0].prompt).toBe("Say hello to me");
    expect(withPrompts.suggestedPrompts[1].summaryTitle).toBe("Help");

    // Update suggested prompts (replaces)
    const updateResponse = await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${createdAgent.id}`,
      data: {
        suggestedPrompts: [
          { summaryTitle: "New prompt", prompt: "A new prompt" },
        ],
      },
    });
    const updated = await updateResponse.json();
    expect(updated.suggestedPrompts).toHaveLength(1);
    expect(updated.suggestedPrompts[0].summaryTitle).toBe("New prompt");

    // Clear suggested prompts
    const clearResponse = await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${createdAgent.id}`,
      data: {
        systemPrompt: null,
        suggestedPrompts: [],
      },
    });
    const cleared = await clearResponse.json();
    expect(cleared.systemPrompt).toBeNull();
    expect(cleared.suggestedPrompts).toHaveLength(0);

    // Verify persistence
    const getResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/agents/${createdAgent.id}`,
    });
    const fetched = await getResponse.json();
    expect(fetched.systemPrompt).toBeNull();
    expect(fetched.suggestedPrompts).toHaveLength(0);
  });

  test("should create agent with suggestedPrompts", async ({
    request,
    makeApiRequest,
  }) => {
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/agents",
      data: {
        name: `Agent With Suggestions ${uniqueSuffix}`,
        agentType: "agent",
        scope: "personal",
        teams: [],
        suggestedPrompts: [
          { summaryTitle: "Quick start", prompt: "Get me started" },
        ],
      },
    });
    const agent = await createResponse.json();

    expect(agent.suggestedPrompts).toHaveLength(1);
    expect(agent.suggestedPrompts[0].summaryTitle).toBe("Quick start");
    expect(agent.suggestedPrompts[0].prompt).toBe("Get me started");
  });

  test("should delete an agent", async ({
    request,
    createAgent,
    makeApiRequest,
  }) => {
    // Create an agent first
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const createResponse = await createAgent(
      request,
      `Agent for Delete Test ${uniqueSuffix}`,
      "personal",
    );
    const createdAgent = await createResponse.json();

    const deleteResponse = await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/agents/${createdAgent.id}`,
    });
    const deletedAgent = await deleteResponse.json();

    expect(deletedAgent).toHaveProperty("success");
    expect(deletedAgent.success).toBe(true);

    // Verify agent is deleted by trying to get it
    const getResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/agents/${createdAgent.id}`,
      ignoreStatusCheck: true,
    });
    expect(getResponse.status()).toBe(404);
  });

  test("should get default MCP gateway", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/mcp-gateways/default",
    });
    const agent = await response.json();

    expect(agent).toHaveProperty("id");
    expect(agent).toHaveProperty("name");
    expect(agent.isDefault).toBe(true);
    expect(Array.isArray(agent.tools)).toBe(true);
    expect(Array.isArray(agent.teams)).toBe(true);
  });
});
