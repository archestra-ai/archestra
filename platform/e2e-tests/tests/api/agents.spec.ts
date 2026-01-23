import { expect, test } from "./fixtures";

test.describe("Agents API CRUD", () => {
  test("should get all agents", async ({ request, makeApiRequest }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/agents/all",
    });
    const agents = await response.json();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThan(0);
  });

  test("should create a new agent", async ({ request, createAgent }) => {
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const newAgent = {
      name: `Test Agent for Integration ${uniqueSuffix}`,
      isDemo: false,
      teams: [],
    };

    const response = await createAgent(request, newAgent.name);
    const agent = await response.json();

    expect(agent).toHaveProperty("id");
    expect(agent.name).toBe(newAgent.name);
    expect(agent.isDemo).toBe(newAgent.isDemo);
    expect(Array.isArray(agent.tools)).toBe(true);
    expect(Array.isArray(agent.teams)).toBe(true);
  });

  test("should get agent by ID", async ({
    request,
    createAgent,
    makeApiRequest,
  }) => {
    // Create an agent first
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const agentName = `Agent for Get By ID Test ${uniqueSuffix}`;
    const createResponse = await createAgent(request, agentName);
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
    );
    const createdAgent = await createResponse.json();

    const updateData = {
      name: `Updated Test Agent ${uniqueSuffix}`,
      isDemo: true,
    };

    const updateResponse = await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${createdAgent.id}`,
      data: updateData,
    });
    const updatedAgent = await updateResponse.json();

    expect(updatedAgent).toHaveProperty("id");
    expect(updatedAgent.name).toBe(updateData.name);
    expect(updatedAgent.isDemo).toBe(updateData.isDemo);
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

  test("should get default agent", async ({ request, makeApiRequest }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/agents/default",
    });
    const agent = await response.json();

    expect(agent).toHaveProperty("id");
    expect(agent).toHaveProperty("name");
    expect(agent.isDefault).toBe(true);
    expect(Array.isArray(agent.tools)).toBe(true);
    expect(Array.isArray(agent.teams)).toBe(true);
  });
});
