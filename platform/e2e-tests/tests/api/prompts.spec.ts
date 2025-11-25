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

    // Step 2: Create a system prompt with agentId
    const createPromptResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/prompts",
      data: {
        name: "Test System Prompt",
        agentId: agent.id,
        systemPrompt: "You are a helpful assistant.",
      },
    });
    const originalPrompt = await createPromptResponse.json();

    // Verify prompt was created correctly
    expect(originalPrompt.id).toBeDefined();
    expect(originalPrompt.agentId).toBe(agent.id);
    expect(originalPrompt.systemPrompt).toBe("You are a helpful assistant.");
    expect(originalPrompt.version).toBe(1);
    expect(originalPrompt.isActive).toBe(true);

    // Step 3: Get all prompts and verify this prompt is returned
    const allPromptsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/prompts",
    });
    const allPrompts = await allPromptsResponse.json();
    const foundPrompt = allPrompts.find((p: { id: string }) => p.id === originalPrompt.id);
    expect(foundPrompt).toBeDefined();
    expect(foundPrompt.agentId).toBe(agent.id);

    // Step 4: Update the prompt (this should create a new version)
    const updatePromptResponse = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/prompts/${originalPrompt.id}`,
      data: {
        systemPrompt: "You are an updated helpful assistant.",
      },
    });
    const updatedPrompt = await updatePromptResponse.json();

    // Verify a new version was created
    expect(updatedPrompt.id).not.toBe(originalPrompt.id);
    expect(updatedPrompt.version).toBe(2);
    expect(updatedPrompt.systemPrompt).toBe("You are an updated helpful assistant.");
    expect(updatedPrompt.agentId).toBe(agent.id);
    expect(updatedPrompt.isActive).toBe(true);

    // Step 5: Verify the original prompt is now inactive
    const originalPromptResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/prompts/${originalPrompt.id}`,
    });
    const originalPromptAfterUpdate = await originalPromptResponse.json();
    expect(originalPromptAfterUpdate.isActive).toBe(false);

    // Step 6: Verify the new version is returned when fetching all prompts
    const allPromptsAfterUpdateResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/prompts",
    });
    const allPromptsAfterUpdate = await allPromptsAfterUpdateResponse.json();
    const foundUpdatedPrompt = allPromptsAfterUpdate.find(
      (p: { id: string }) => p.id === updatedPrompt.id,
    );
    expect(foundUpdatedPrompt).toBeDefined();
    expect(foundUpdatedPrompt.version).toBe(2);
    expect(foundUpdatedPrompt.agentId).toBe(agent.id);

    // Step 7: Verify version history
    const versionsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/prompts/${originalPrompt.id}/versions`,
    });
    const versions = await versionsResponse.json();
    expect(versions.length).toBe(2);
    const version2 = versions.find((v: { version: number }) => v.version === 2);
    const version1 = versions.find((v: { version: number }) => v.version === 1);
    expect(version2).toBeDefined();
    expect(version2.isActive).toBe(true);
    expect(version1).toBeDefined();
    expect(version1.isActive).toBe(false);

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

    // Step 2: Create a prompt for agent1 with the same name that will be shared conceptually
    const createPromptResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/prompts",
      data: {
        name: "Shared System Prompt",
        agentId: agent1.id,
        systemPrompt: "Original shared prompt content.",
      },
    });
    const originalPrompt = await createPromptResponse.json();

    // Step 3: Create separate prompts with the same name for agent2 and agent3
    // (In the new structure, each agent needs its own prompt instance)
    const prompt2Response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/prompts",
      data: {
        name: "Shared System Prompt",
        agentId: agent2.id,
        systemPrompt: "Original shared prompt content.",
      },
    });
    const prompt2 = await prompt2Response.json();

    const prompt3Response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/prompts",
      data: {
        name: "Shared System Prompt",
        agentId: agent3.id,
        systemPrompt: "Original shared prompt content.",
      },
    });
    const prompt3 = await prompt3Response.json();

    // Step 4: Verify all prompts exist
    expect(originalPrompt.agentId).toBe(agent1.id);
    expect(prompt2.agentId).toBe(agent2.id);
    expect(prompt3.agentId).toBe(agent3.id);
    expect(originalPrompt.name).toBe("Shared System Prompt");
    expect(prompt2.name).toBe("Shared System Prompt");
    expect(prompt3.name).toBe("Shared System Prompt");

    // Step 5: Update the prompt for agent1 (this should create a new version)
    const updatePromptResponse = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/prompts/${originalPrompt.id}`,
      data: {
        systemPrompt: "Updated shared prompt content.",
      },
    });
    const updatedPrompt = await updatePromptResponse.json();

    // Step 6: Verify the new version belongs to agent1
    expect(updatedPrompt.agentId).toBe(agent1.id);
    expect(updatedPrompt.version).toBe(2);
    expect(updatedPrompt.systemPrompt).toBe("Updated shared prompt content.");

    // Step 7: Verify prompts for agent2 and agent3 are unchanged
    const prompt2AfterUpdateResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/prompts/${prompt2.id}`,
    });
    const prompt2AfterUpdate = await prompt2AfterUpdateResponse.json();
    expect(prompt2AfterUpdate.version).toBe(1);
    expect(prompt2AfterUpdate.systemPrompt).toBe("Original shared prompt content.");

    const prompt3AfterUpdateResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/prompts/${prompt3.id}`,
    });
    const prompt3AfterUpdate = await prompt3AfterUpdateResponse.json();
    expect(prompt3AfterUpdate.version).toBe(1);
    expect(prompt3AfterUpdate.systemPrompt).toBe("Original shared prompt content.");

    // Cleanup
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/prompts/${updatedPrompt.id}`,
    });
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/prompts/${prompt2.id}`,
    });
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/prompts/${prompt3.id}`,
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
    createAgent,
    makeApiRequest,
  }) => {
    // Create an agent first since prompts now require agentId
    const createAgentResponse = await createAgent(request, "Test Agent for Prompt");
    const agent = await createAgentResponse.json();

    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/prompts",
      data: {
        name: "Test Prompt",
        agentId: agent.id,
        systemPrompt: "Test system content",
        userPrompt: "Test user content",
      },
    });
    const prompt = await createResponse.json();

    expect(prompt).toHaveProperty("id");
    expect(prompt.name).toBe("Test Prompt");
    expect(prompt.agentId).toBe(agent.id);
    expect(prompt.systemPrompt).toBe("Test system content");
    expect(prompt.userPrompt).toBe("Test user content");
    expect(prompt.version).toBe(1);
    expect(prompt.isActive).toBe(true);

    // Verify we can retrieve it
    const getResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/prompts/${prompt.id}`,
    });
    const retrievedPrompt = await getResponse.json();
    expect(retrievedPrompt.id).toBe(prompt.id);
    expect(retrievedPrompt.name).toBe("Test Prompt");
    expect(retrievedPrompt.systemPrompt).toBe("Test system content");

    // Cleanup
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/prompts/${prompt.id}`,
    });
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/agents/${agent.id}`,
    });
  });
});
