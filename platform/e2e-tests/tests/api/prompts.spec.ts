import { expect, test } from "./fixtures";

test.describe("Prompts API", () => {
  test("should maintain agent-prompt relationships when updating a prompt", async ({
    request,
    createAgent,
    makeApiRequest,
  }) => {
    // Step 1: Create an agent
    const createAgentResponse = await createAgent(
      request,
      "Agent for Prompt Update Test",
    );
    const agent = await createAgentResponse.json();

    // Step 2: Create a system prompt
    const createPromptResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/prompts",
      data: {
        name: "Test System Prompt",
        type: "system",
        content: "You are a helpful assistant.",
      },
    });
    const originalPrompt = await createPromptResponse.json();

    // Step 3: Assign the prompt to the agent
    const assignPromptResponse = await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${agent.id}/prompts`,
      data: {
        systemPromptId: originalPrompt.id,
        regularPromptIds: [],
      },
    });
    expect(assignPromptResponse.ok()).toBe(true);

    // Step 4: Verify the agent has the prompt assigned
    const agentPromptsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/agents/${agent.id}/prompts`,
    });
    const agentPrompts = await agentPromptsResponse.json();
    const systemPrompt = agentPrompts.find(
      // biome-ignore lint/suspicious/noExplicitAny: test...
      (ap: any) => ap.prompt.type === "system",
    );
    expect(systemPrompt).toBeDefined();
    expect(systemPrompt.promptId).toBe(originalPrompt.id);

    // Step 5: Update the prompt (this should create a new version)
    const updatePromptResponse = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/prompts/${originalPrompt.id}`,
      data: {
        content: "You are an updated helpful assistant.",
      },
    });
    const updatedPrompt = await updatePromptResponse.json();

    // Verify a new version was created
    expect(updatedPrompt.id).not.toBe(originalPrompt.id);
    expect(updatedPrompt.version).toBe(2);
    expect(updatedPrompt.content).toBe("You are an updated helpful assistant.");

    // Step 6: Verify the agent now uses the new version (critical bug fix verification)
    const agentPromptsAfterUpdateResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/agents/${agent.id}/prompts`,
    });
    const agentPromptsAfterUpdate =
      await agentPromptsAfterUpdateResponse.json();

    // This is the key assertion: the agent should still have a system prompt
    // and it should be the new version
    const systemPromptAfterUpdate = agentPromptsAfterUpdate.find(
      // biome-ignore lint/suspicious/noExplicitAny: test...
      (ap: any) => ap.prompt.type === "system",
    );
    expect(systemPromptAfterUpdate).toBeDefined();
    expect(systemPromptAfterUpdate.promptId).toBe(updatedPrompt.id);
    expect(systemPromptAfterUpdate.prompt.version).toBe(2);
    expect(systemPromptAfterUpdate.prompt.content).toBe(
      "You are an updated helpful assistant.",
    );

    // Step 7: Verify the new version has the agent in its agents list
    const newVersionPromptResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/prompts/${updatedPrompt.id}`,
    });
    const newVersionPrompt = await newVersionPromptResponse.json();
    expect(newVersionPrompt.agents).toBeDefined();
    expect(newVersionPrompt.agents.length).toBe(1);
    expect(newVersionPrompt.agents[0].id).toBe(agent.id);

    // Cleanup
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/prompts/${updatedPrompt.id}`,
    });
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/agents/${agent.id}`,
    });
  });

  test("should preserve multiple agent relationships when updating a prompt", async ({
    request,
    createAgent,
    makeApiRequest,
  }) => {
    // Step 1: Create multiple agents
    const agent1Response = await createAgent(request, "Agent 1 for Multi Test");
    const agent1 = await agent1Response.json();

    const agent2Response = await createAgent(request, "Agent 2 for Multi Test");
    const agent2 = await agent2Response.json();

    const agent3Response = await createAgent(request, "Agent 3 for Multi Test");
    const agent3 = await agent3Response.json();

    // Step 2: Create a system prompt
    const createPromptResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/prompts",
      data: {
        name: "Shared System Prompt",
        type: "system",
        content: "Original shared prompt content.",
      },
    });
    const originalPrompt = await createPromptResponse.json();

    // Step 3: Assign the prompt to all three agents
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${agent1.id}/prompts`,
      data: {
        systemPromptId: originalPrompt.id,
        regularPromptIds: [],
      },
    });

    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${agent2.id}/prompts`,
      data: {
        systemPromptId: originalPrompt.id,
        regularPromptIds: [],
      },
    });

    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${agent3.id}/prompts`,
      data: {
        systemPromptId: originalPrompt.id,
        regularPromptIds: [],
      },
    });

    // Step 4: Verify all agents have the prompt
    const originalPromptResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/prompts/${originalPrompt.id}`,
    });
    const originalPromptWithAgents = await originalPromptResponse.json();
    expect(originalPromptWithAgents.agents.length).toBe(3);

    // Step 5: Update the prompt
    const updatePromptResponse = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/prompts/${originalPrompt.id}`,
      data: {
        content: "Updated shared prompt content.",
      },
    });
    const updatedPrompt = await updatePromptResponse.json();

    // Step 6: Verify all three agents now use the new version
    const newVersionPromptResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/prompts/${updatedPrompt.id}`,
    });
    const newVersionPrompt = await newVersionPromptResponse.json();
    expect(newVersionPrompt.agents.length).toBe(3);

    const agentIds = newVersionPrompt.agents.map((a: { id: string }) => a.id);
    expect(agentIds).toContain(agent1.id);
    expect(agentIds).toContain(agent2.id);
    expect(agentIds).toContain(agent3.id);

    // Cleanup
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/prompts/${updatedPrompt.id}`,
    });
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/agents/${agent1.id}`,
    });
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/agents/${agent2.id}`,
    });
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/agents/${agent3.id}`,
    });
  });

  test("should create and retrieve a prompt", async ({
    request,
    makeApiRequest,
  }) => {
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/prompts",
      data: {
        name: "Test Prompt",
        type: "system",
        content: "Test content",
      },
    });
    const prompt = await createResponse.json();

    expect(prompt).toHaveProperty("id");
    expect(prompt.name).toBe("Test Prompt");
    expect(prompt.type).toBe("system");
    expect(prompt.content).toBe("Test content");
    expect(prompt.version).toBe(1);
    expect(prompt.isActive).toBe(true);

    // Cleanup
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/prompts/${prompt.id}`,
    });
  });
});
