import { expect, test } from "./fixtures";

test.describe("Chat API Keys CRUD", () => {
  test.describe.configure({ mode: "serial" });

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

  test("should create a personal chat API key", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Test Anthropic Key",
        provider: "anthropic",
        apiKey: "sk-ant-test-key-12345",
        scope: "personal",
      },
    });

    expect(response.ok()).toBe(true);
    const apiKey = await response.json();

    expect(apiKey).toHaveProperty("id");
    expect(apiKey.name).toBe("Test Anthropic Key");
    expect(apiKey.provider).toBe("anthropic");
    expect(apiKey.scope).toBe("personal");
    expect(apiKey.secretId).toBeDefined();

    // Cleanup
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${apiKey.id}`,
    });
  });

  test("should create an org-wide chat API key", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Org Wide Test Key",
        provider: "anthropic",
        apiKey: "sk-ant-org-wide-test-key",
        scope: "org_wide",
      },
    });

    expect(response.ok()).toBe(true);
    const apiKey = await response.json();

    expect(apiKey.scope).toBe("org_wide");

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

  test("should enforce one personal key per user per provider", async ({
    request,
    makeApiRequest,
  }) => {
    // Create first personal key for anthropic
    const key1Response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Personal Anthropic Key 1",
        provider: "anthropic",
        apiKey: "sk-ant-personal-test-1",
        scope: "personal",
      },
    });
    expect(key1Response.ok()).toBe(true);
    const key1 = await key1Response.json();

    // Try to create second personal key for same provider - should fail with unique constraint violation
    const key2Response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Personal Anthropic Key 2",
        provider: "anthropic",
        apiKey: "sk-ant-personal-test-2",
        scope: "personal",
      },
      ignoreStatusCheck: true,
    });
    // Backend returns 500 for unique constraint violations (database error)
    expect(key2Response.ok()).toBe(false);

    // Cleanup
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${key1.id}`,
    });
  });

  test("should allow personal keys for different providers", async ({
    request,
    makeApiRequest,
  }) => {
    // Create personal anthropic key
    const anthropicResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Personal Anthropic Key",
        provider: "anthropic",
        apiKey: "sk-ant-multi-provider-test",
        scope: "personal",
      },
    });
    expect(anthropicResponse.ok()).toBe(true);
    const anthropicKey = await anthropicResponse.json();

    // Create personal openai key - should succeed (different provider)
    const openaiResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Personal OpenAI Key",
        provider: "openai",
        apiKey: "sk-openai-multi-provider-test",
        scope: "personal",
      },
    });
    expect(openaiResponse.ok()).toBe(true);
    const openaiKey = await openaiResponse.json();

    // Cleanup
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
});

test.describe("Chat API Keys Available Endpoint", () => {
  test.describe.configure({ mode: "serial" });

  // Use openai provider to avoid conflicts with CRUD tests that use anthropic
  test("should get available API keys for current user", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a personal key first
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Available Test Key",
        provider: "openai",
        apiKey: "sk-openai-available-test",
        scope: "personal",
      },
    });
    const createdKey = await createResponse.json();

    // Get available keys
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/chat-api-keys/available",
    });

    expect(response.ok()).toBe(true);
    const availableKeys = await response.json();
    expect(Array.isArray(availableKeys)).toBe(true);
    expect(
      availableKeys.some((k: { id: string }) => k.id === createdKey.id),
    ).toBe(true);

    // Cleanup
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${createdKey.id}`,
    });
  });

  test("should filter available API keys by provider", async ({
    request,
    makeApiRequest,
  }) => {
    // Create an openai key
    const openaiResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Filter OpenAI Key",
        provider: "openai",
        apiKey: "sk-openai-filter-test",
        scope: "personal",
      },
    });
    const openaiKey = await openaiResponse.json();

    // Get available keys filtered by anthropic - should not include openai key
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/chat-api-keys/available?provider=anthropic",
    });

    expect(response.ok()).toBe(true);
    const availableKeys = await response.json();
    expect(
      availableKeys.every(
        (k: { provider: string }) => k.provider === "anthropic",
      ),
    ).toBe(true);

    // Cleanup
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${openaiKey.id}`,
    });
  });
});

test.describe("Chat API Keys Team Scope", () => {
  test.describe.configure({ mode: "serial" });

  test("should create a team-scoped API key", async ({
    request,
    makeApiRequest,
  }) => {
    // First get a team that the admin user belongs to
    const teamsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/teams",
    });
    const teams = await teamsResponse.json();

    // Skip if no teams exist
    if (teams.length === 0) {
      return;
    }

    const teamId = teams[0].id;

    // Create team-scoped key
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Team Test Key",
        provider: "openai",
        apiKey: "sk-openai-team-test-key",
        scope: "team",
        teamId,
      },
    });

    expect(response.ok()).toBe(true);
    const apiKey = await response.json();

    expect(apiKey.scope).toBe("team");
    expect(apiKey.teamId).toBe(teamId);

    // Cleanup
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${apiKey.id}`,
    });
  });

  test("should require teamId for team-scoped keys", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Team Key Without TeamId",
        provider: "anthropic",
        apiKey: "sk-ant-no-team-id",
        scope: "team",
        // teamId is missing
      },
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(400);
  });
});

test.describe("Chat API Keys Scope Update", () => {
  test.describe.configure({ mode: "serial" });

  test("should update scope from personal to org_wide", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a personal key first
    // Use gemini provider to avoid conflicts with other tests using openai personal keys
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Scope Update Test Key",
        provider: "gemini",
        apiKey: "gemini-scope-update-test",
        scope: "personal",
      },
    });
    const createdKey = await createResponse.json();

    // Update scope to org_wide
    const updateResponse = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/chat-api-keys/${createdKey.id}`,
      data: {
        scope: "org_wide",
      },
    });

    expect(updateResponse.ok()).toBe(true);
    const updatedKey = await updateResponse.json();
    expect(updatedKey.scope).toBe("org_wide");
    expect(updatedKey.userId).toBeNull();

    // Cleanup
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${createdKey.id}`,
    });
  });
});

test.describe("Chat API Keys Access Control", () => {
  test.describe.configure({ mode: "serial" });

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
