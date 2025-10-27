import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { API_BASE_URL } from "../../consts";
import { createApiKey, deleteApiKey } from "../../utils/auth";

const createAgent = async (request: APIRequestContext, apiKey: string, name: string = "Test Agent") => {
  const newAgent = {
    name,
    isDemo: false,
    teams: [],
  };

  const response = await request.post(`${API_BASE_URL}/api/agents`, {
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    data: newAgent,
  });

  if (!response.ok()) {
    throw new Error(`Failed to create agent: ${response.status()} ${await response.text()}`);
  }

  return response.json();
};

test.describe("Agents API CRUD", () => {
  let apiKey: string;
  let apiKeyId: string;

  test.beforeAll(async ({ request }) => {
    // Create API key for testing
    const keyData = await createApiKey(request, "Agents API Test Key");
    apiKey = keyData.key;
    apiKeyId = keyData.id;
  });

  test.afterAll(async ({ request }) => {
    // Clean up API key after tests
    if (apiKeyId) {
      await deleteApiKey(request, apiKeyId);
    }
  });

  test("should get all agents", async ({ request }) => {
    const response = await request.get(`${API_BASE_URL}/api/agents`, {
      headers: {
        Authorization: apiKey,
      },
    });

    expect(response.status()).toBe(200);
    const agents = await response.json();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThan(0);

    // Verify agent structure
    const agent = agents[0];
    expect(agent).toHaveProperty("id");
    expect(agent).toHaveProperty("name");
    expect(agent).toHaveProperty("tools");
    expect(agent).toHaveProperty("teams");
    expect(Array.isArray(agent.tools)).toBe(true);
    expect(Array.isArray(agent.teams)).toBe(true);
  });

  test("should create a new agent", async ({ request }) => {
    const newAgent = {
      name: "Test Agent for Integration",
      isDemo: false,
      teams: [],
    };

    const response = await request.post(`${API_BASE_URL}/api/agents`, {
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      data: newAgent,
    });

    expect(response.status()).toBe(200);
    const agent = await response.json();

    expect(agent).toHaveProperty("id");
    expect(agent.name).toBe(newAgent.name);
    expect(agent.isDemo).toBe(newAgent.isDemo);
    expect(Array.isArray(agent.tools)).toBe(true);
    expect(Array.isArray(agent.teams)).toBe(true);
  });

  test("should get agent by ID", async ({ request }) => {
    // Create an agent first
    const createdAgent = await createAgent(request, apiKey, "Agent for Get By ID Test");

    const response = await request.get(`${API_BASE_URL}/api/agents/${createdAgent.id}`, {
      headers: {
        Authorization: apiKey,
      },
    });

    expect(response.status()).toBe(200);
    const agent = await response.json();

    expect(agent.id).toBe(createdAgent.id);
    expect(agent.name).toBe("Agent for Get By ID Test");
    expect(agent).toHaveProperty("tools");
    expect(agent).toHaveProperty("teams");
  });

  test("should update an agent", async ({ request }) => {
    // Create an agent first
    const createdAgent = await createAgent(request, apiKey, "Agent for Update Test");

    const updateData = {
      name: "Updated Test Agent",
      isDemo: true,
    };

    const response = await request.put(`${API_BASE_URL}/api/agents/${createdAgent.id}`, {
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      data: updateData,
    });

    expect(response.status()).toBe(200);
    const agent = await response.json();

    expect(agent.id).toBe(createdAgent.id);
    expect(agent.name).toBe(updateData.name);
    expect(agent.isDemo).toBe(updateData.isDemo);
  });

  test("should delete an agent", async ({ request }) => {
    // Create an agent first
    const createdAgent = await createAgent(request, apiKey, "Agent for Delete Test");

    const response = await request.delete(`${API_BASE_URL}/api/agents/${createdAgent.id}`, {
      headers: {
        Authorization: apiKey,
      },
    });

    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result.success).toBe(true);

    // Verify agent is deleted by trying to get it
    const getResponse = await request.get(`${API_BASE_URL}/api/agents/${createdAgent.id}`, {
      headers: {
        Authorization: apiKey,
      },
    });
    expect(getResponse.status()).toBe(404);
  });

  test("should get default agent", async ({ request }) => {
    const response = await request.get(`${API_BASE_URL}/api/agents/default`, {
      headers: {
        Authorization: apiKey,
      },
    });

    expect(response.status()).toBe(200);
    const agent = await response.json();

    expect(agent).toHaveProperty("id");
    expect(agent).toHaveProperty("name");
    expect(agent.isDefault).toBe(true);
    expect(Array.isArray(agent.tools)).toBe(true);
    expect(Array.isArray(agent.teams)).toBe(true);
  });
});
