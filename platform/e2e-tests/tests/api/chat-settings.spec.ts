import { expect, test } from "./fixtures";

test.describe("Chat API Keys CRUD", () => {
  test("should list chat API keys (initially empty or with existing keys)", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/chat-api-keys",
    });
    const apiKeys = await response.json();
    expect(Array.isArray(apiKeys)).toBe(true);
  });

  test("should create a chat API key", async ({ request, makeApiRequest }) => {
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Test Anthropic Key",
        provider: "anthropic",
        apiKey: "sk-ant-test-key-12345",
        isOrganizationDefault: false,
      },
    });

    expect(response.ok()).toBe(true);
    const apiKey = await response.json();

    expect(apiKey).toHaveProperty("id");
    expect(apiKey.name).toBe("Test Anthropic Key");
    expect(apiKey.provider).toBe("anthropic");
    expect(apiKey.isOrganizationDefault).toBe(false);
    expect(apiKey.secretId).toBeDefined();

    // Cleanup
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${apiKey.id}`,
    });
  });

  test("should create a chat API key as organization default", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Default Test Key",
        provider: "anthropic",
        apiKey: "sk-ant-default-test-key",
        isOrganizationDefault: true,
      },
    });

    expect(response.ok()).toBe(true);
    const apiKey = await response.json();

    expect(apiKey.isOrganizationDefault).toBe(true);

    // Cleanup
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${apiKey.id}`,
    });
  });

  test("should get a specific chat API key by ID", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a key first
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Get By ID Test Key",
        provider: "anthropic",
        apiKey: "sk-ant-get-by-id-test",
      },
    });
    const createdKey = await createResponse.json();

    // Get the key by ID
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/chat-api-keys/${createdKey.id}`,
    });

    expect(response.ok()).toBe(true);
    const apiKey = await response.json();

    expect(apiKey.id).toBe(createdKey.id);
    expect(apiKey.name).toBe("Get By ID Test Key");
    expect(apiKey).toHaveProperty("profiles");
    expect(Array.isArray(apiKey.profiles)).toBe(true);

    // Cleanup
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${createdKey.id}`,
    });
  });

  test("should update a chat API key name", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a key first
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Original Name",
        provider: "anthropic",
        apiKey: "sk-ant-update-test",
      },
    });
    const createdKey = await createResponse.json();

    // Update the key
    const updateResponse = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/chat-api-keys/${createdKey.id}`,
      data: {
        name: "Updated Name",
      },
    });

    expect(updateResponse.ok()).toBe(true);
    const updatedKey = await updateResponse.json();

    expect(updatedKey.name).toBe("Updated Name");

    // Cleanup
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${createdKey.id}`,
    });
  });

  test("should delete a chat API key", async ({ request, makeApiRequest }) => {
    // Create a key first
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Delete Test Key",
        provider: "anthropic",
        apiKey: "sk-ant-delete-test",
      },
    });
    const createdKey = await createResponse.json();

    // Delete the key
    const deleteResponse = await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${createdKey.id}`,
    });

    expect(deleteResponse.ok()).toBe(true);
    const result = await deleteResponse.json();
    expect(result.success).toBe(true);

    // Verify it's deleted
    const getResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/chat-api-keys/${createdKey.id}`,
      ignoreStatusCheck: true,
    });

    expect(getResponse.status()).toBe(404);
  });

  test("should set and unset organization default", async ({
    request,
    makeApiRequest,
  }) => {
    // Create two keys
    const key1Response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Key 1",
        provider: "anthropic",
        apiKey: "sk-ant-key1-test",
        isOrganizationDefault: true,
      },
    });
    const key1 = await key1Response.json();

    const key2Response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Key 2",
        provider: "anthropic",
        apiKey: "sk-ant-key2-test",
      },
    });
    const key2 = await key2Response.json();

    expect(key1.isOrganizationDefault).toBe(true);
    expect(key2.isOrganizationDefault).toBe(false);

    // Set key2 as default
    const setDefaultResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/chat-api-keys/${key2.id}/set-default`,
    });
    expect(setDefaultResponse.ok()).toBe(true);
    const updatedKey2 = await setDefaultResponse.json();
    expect(updatedKey2.isOrganizationDefault).toBe(true);

    // Verify key1 is no longer default
    const key1GetResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/chat-api-keys/${key1.id}`,
    });
    const key1After = await key1GetResponse.json();
    expect(key1After.isOrganizationDefault).toBe(false);

    // Unset key2 as default
    const unsetDefaultResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/chat-api-keys/${key2.id}/unset-default`,
    });
    expect(unsetDefaultResponse.ok()).toBe(true);
    const unsetKey2 = await unsetDefaultResponse.json();
    expect(unsetKey2.isOrganizationDefault).toBe(false);

    // Cleanup
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${key1.id}`,
    });
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${key2.id}`,
    });
  });

  test("should update profile assignments for an API key", async ({
    request,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    // Create an API key
    const keyResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Profile Assignment Test Key",
        provider: "anthropic",
        apiKey: "sk-ant-profile-test",
      },
    });
    const apiKey = await keyResponse.json();

    // Create an agent/profile
    const agentResponse = await createAgent(request, "Test Agent for API Key");
    const agent = await agentResponse.json();

    // Assign the profile to the API key
    const assignResponse = await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/chat-api-keys/${apiKey.id}/profiles`,
      data: {
        profileIds: [agent.id],
      },
    });

    expect(assignResponse.ok()).toBe(true);
    const updatedKey = await assignResponse.json();
    expect(updatedKey.profiles).toHaveLength(1);
    expect(updatedKey.profiles[0].id).toBe(agent.id);

    // Unassign the profile
    const unassignResponse = await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/chat-api-keys/${apiKey.id}/profiles`,
      data: {
        profileIds: [],
      },
    });

    expect(unassignResponse.ok()).toBe(true);
    const clearedKey = await unassignResponse.json();
    expect(clearedKey.profiles).toHaveLength(0);

    // Cleanup
    await deleteAgent(request, agent.id);
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${apiKey.id}`,
    });
  });

  test("should return 404 for non-existent API key", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/chat-api-keys/00000000-0000-0000-0000-000000000000",
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(404);
  });

  test("should enforce single key per provider per profile constraint", async ({
    request,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    // Create two API keys of the same provider
    const key1Response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Anthropic Key 1",
        provider: "anthropic",
        apiKey: "sk-ant-constraint-test-1",
      },
    });
    const key1 = await key1Response.json();

    const key2Response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Anthropic Key 2",
        provider: "anthropic",
        apiKey: "sk-ant-constraint-test-2",
      },
    });
    const key2 = await key2Response.json();

    // Create a profile
    const agentResponse = await createAgent(request, "Constraint Test Profile");
    const agent = await agentResponse.json();

    // Assign key1 to profile
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/chat-api-keys/${key1.id}/profiles`,
      data: {
        profileIds: [agent.id],
      },
    });

    // Verify key1 is assigned
    const key1GetResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/chat-api-keys/${key1.id}`,
    });
    const key1After = await key1GetResponse.json();
    expect(key1After.profiles).toHaveLength(1);
    expect(key1After.profiles[0].id).toBe(agent.id);

    // Assign key2 to the same profile - should replace key1
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/chat-api-keys/${key2.id}/profiles`,
      data: {
        profileIds: [agent.id],
      },
    });

    // Verify key2 is now assigned and key1 is no longer assigned
    const key2GetResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/chat-api-keys/${key2.id}`,
    });
    const key2After = await key2GetResponse.json();
    expect(key2After.profiles).toHaveLength(1);
    expect(key2After.profiles[0].id).toBe(agent.id);

    const key1GetResponse2 = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/chat-api-keys/${key1.id}`,
    });
    const key1After2 = await key1GetResponse2.json();
    expect(key1After2.profiles).toHaveLength(0);

    // Cleanup
    await deleteAgent(request, agent.id);
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${key1.id}`,
    });
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${key2.id}`,
    });
  });

  test("should allow different providers on same profile", async ({
    request,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    // Create API keys of different providers
    const anthropicKeyResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Anthropic Provider Key",
        provider: "anthropic",
        apiKey: "sk-ant-multi-provider-test",
      },
    });
    const anthropicKey = await anthropicKeyResponse.json();

    const openaiKeyResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "OpenAI Provider Key",
        provider: "openai",
        apiKey: "sk-openai-multi-provider-test",
      },
    });
    const openaiKey = await openaiKeyResponse.json();

    // Create a profile
    const agentResponse = await createAgent(
      request,
      "Multi Provider Test Profile",
    );
    const agent = await agentResponse.json();

    // Assign both keys to the same profile
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/chat-api-keys/${anthropicKey.id}/profiles`,
      data: {
        profileIds: [agent.id],
      },
    });

    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/chat-api-keys/${openaiKey.id}/profiles`,
      data: {
        profileIds: [agent.id],
      },
    });

    // Both keys should be assigned
    const anthropicKeyGet = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/chat-api-keys/${anthropicKey.id}`,
    });
    const anthropicKeyAfter = await anthropicKeyGet.json();
    expect(anthropicKeyAfter.profiles).toHaveLength(1);

    const openaiKeyGet = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/chat-api-keys/${openaiKey.id}`,
    });
    const openaiKeyAfter = await openaiKeyGet.json();
    expect(openaiKeyAfter.profiles).toHaveLength(1);

    // Cleanup
    await deleteAgent(request, agent.id);
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${anthropicKey.id}`,
    });
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${openaiKey.id}`,
    });
  });

  test("should bulk assign API keys to profiles", async ({
    request,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    // Create API keys
    const key1Response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Bulk Assign Key 1",
        provider: "anthropic",
        apiKey: "sk-ant-bulk-test-1",
      },
    });
    const key1 = await key1Response.json();

    const key2Response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Bulk Assign Key 2",
        provider: "openai",
        apiKey: "sk-openai-bulk-test-2",
      },
    });
    const key2 = await key2Response.json();

    // Create profiles
    const agent1Response = await createAgent(request, "Bulk Assign Profile 1");
    const agent1 = await agent1Response.json();

    const agent2Response = await createAgent(request, "Bulk Assign Profile 2");
    const agent2 = await agent2Response.json();

    // Bulk assign both keys to both profiles
    const bulkAssignResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys/bulk-assign",
      data: {
        chatApiKeyIds: [key1.id, key2.id],
        profileIds: [agent1.id, agent2.id],
      },
    });

    expect(bulkAssignResponse.ok()).toBe(true);
    const result = await bulkAssignResponse.json();
    expect(result.success).toBe(true);
    expect(result.assignedCount).toBe(4); // 2 keys * 2 profiles

    // Verify assignments
    const key1Get = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/chat-api-keys/${key1.id}`,
    });
    const key1After = await key1Get.json();
    expect(key1After.profiles).toHaveLength(2);

    const key2Get = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/chat-api-keys/${key2.id}`,
    });
    const key2After = await key2Get.json();
    expect(key2After.profiles).toHaveLength(2);

    // Cleanup
    await deleteAgent(request, agent1.id);
    await deleteAgent(request, agent2.id);
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${key1.id}`,
    });
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${key2.id}`,
    });
  });
});

test.describe("Chat API Keys Access Control", () => {
  test("member should be able to read chat API keys", async ({
    memberRequest,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request: memberRequest,
      method: "get",
      urlSuffix: "/api/chat-api-keys",
    });

    expect(response.ok()).toBe(true);
  });

  test("member should not be able to create chat API keys", async ({
    memberRequest,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request: memberRequest,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Unauthorized Key",
        provider: "anthropic",
        apiKey: "sk-ant-unauthorized",
      },
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(403);
  });
});
