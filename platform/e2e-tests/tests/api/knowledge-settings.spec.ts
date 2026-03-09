import { expect, test } from "./fixtures";

test.describe("Knowledge Settings API", () => {
  // Run serially since tests modify shared organization settings
  test.describe.configure({ mode: "serial" });

  test("should update embedding model to text-embedding-3-large", async ({
    request,
    updateKnowledgeSettings,
  }) => {
    const response = await updateKnowledgeSettings(request, {
      embeddingModel: "text-embedding-3-large",
    });

    const org = await response.json();
    expect(org.embeddingModel).toBe("text-embedding-3-large");
  });

  test("should read back embedding model after update", async ({
    request,
    makeApiRequest,
    updateKnowledgeSettings,
  }) => {
    await updateKnowledgeSettings(request, {
      embeddingModel: "text-embedding-3-large",
    });

    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/organization",
    });

    const org = await response.json();
    expect(org.embeddingModel).toBe("text-embedding-3-large");
  });

  test("should update reranker model", async ({
    request,
    updateKnowledgeSettings,
  }) => {
    const response = await updateKnowledgeSettings(request, {
      rerankerModel: "gpt-4o-mini",
    });

    const org = await response.json();
    expect(org.rerankerModel).toBe("gpt-4o-mini");
  });

  test("should reject changing embedding model once locked (key + model configured)", async ({
    request,
    makeApiRequest,
    updateKnowledgeSettings,
  }) => {
    // Create a chat API key to use as the embedding key
    const createKeyResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Embedding Lock Test Key",
        provider: "openai",
        apiKey: "sk-openai-embedding-lock-test",
        scope: "org_wide",
      },
    });
    const chatApiKey = await createKeyResponse.json();

    // Set both embedding key and model — this locks the model
    await updateKnowledgeSettings(request, {
      embeddingChatApiKeyId: chatApiKey.id,
      embeddingModel: "text-embedding-3-small",
    });

    // Attempt to change the embedding model — should be rejected
    const changeResponse = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/knowledge-settings",
      data: { embeddingModel: "text-embedding-3-large" },
      ignoreStatusCheck: true,
    });
    expect(changeResponse.status()).toBe(400);

    const errorBody = await changeResponse.json();
    expect(errorBody.error.message).toContain(
      "Embedding model cannot be changed once configured",
    );

    // Setting the same model value should still be allowed
    const sameModelResponse = await updateKnowledgeSettings(request, {
      embeddingModel: "text-embedding-3-small",
    });
    expect(sameModelResponse.ok()).toBe(true);

    // Cleanup: clear the key reference first (unlocks), then reset model
    await updateKnowledgeSettings(request, {
      embeddingChatApiKeyId: null,
    });

    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${chatApiKey.id}`,
    });
  });

  test("should prevent deleting an API key used for embedding", async ({
    request,
    makeApiRequest,
    updateKnowledgeSettings,
  }) => {
    // Create a chat API key
    const createKeyResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Embedding Delete Protection Key",
        provider: "openai",
        apiKey: "sk-openai-delete-protection-test",
        scope: "org_wide",
      },
    });
    const chatApiKey = await createKeyResponse.json();

    // Assign it as the embedding key
    await updateKnowledgeSettings(request, {
      embeddingChatApiKeyId: chatApiKey.id,
    });

    // Attempt to delete — should be rejected
    const deleteResponse = await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${chatApiKey.id}`,
      ignoreStatusCheck: true,
    });
    expect(deleteResponse.status()).toBe(400);

    const errorBody = await deleteResponse.json();
    expect(errorBody.error.message).toContain("embedding");
    expect(errorBody.error.message).toContain(
      "Remove it from Settings > Knowledge before deleting",
    );

    // Cleanup: unassign the key, then delete it
    await updateKnowledgeSettings(request, {
      embeddingChatApiKeyId: null,
    });
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${chatApiKey.id}`,
    });
  });

  test("should prevent deleting an API key used for reranking", async ({
    request,
    makeApiRequest,
    updateKnowledgeSettings,
  }) => {
    // Create a chat API key
    const createKeyResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Reranker Delete Protection Key",
        provider: "openai",
        apiKey: "sk-openai-reranker-delete-test",
        scope: "org_wide",
      },
    });
    const chatApiKey = await createKeyResponse.json();

    // Assign it as the reranker key
    await updateKnowledgeSettings(request, {
      rerankerChatApiKeyId: chatApiKey.id,
    });

    // Attempt to delete — should be rejected
    const deleteResponse = await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${chatApiKey.id}`,
      ignoreStatusCheck: true,
    });
    expect(deleteResponse.status()).toBe(400);

    const errorBody = await deleteResponse.json();
    expect(errorBody.error.message).toContain("reranking");

    // Cleanup: unassign the key, then delete it
    await updateKnowledgeSettings(request, {
      rerankerChatApiKeyId: null,
    });
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${chatApiKey.id}`,
    });
  });

  test("should reject non-OpenAI API key for embedding", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a non-OpenAI chat API key (e.g. anthropic)
    const createKeyResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/chat-api-keys",
      data: {
        name: "Anthropic Key For Embedding Test",
        provider: "anthropic",
        apiKey: "sk-ant-embedding-provider-test",
        scope: "org_wide",
      },
    });
    const chatApiKey = await createKeyResponse.json();

    // Attempt to set it as the embedding key — should be rejected
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/knowledge-settings",
      data: { embeddingChatApiKeyId: chatApiKey.id },
      ignoreStatusCheck: true,
    });
    expect(response.status()).toBe(400);

    const errorBody = await response.json();
    expect(errorBody.error.message).toContain(
      "Embedding API key must be an OpenAI provider key",
    );

    // Cleanup
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/chat-api-keys/${chatApiKey.id}`,
    });
  });

  // Clean up: reset to default
  test("cleanup: reset knowledge settings to defaults", async ({
    request,
    updateKnowledgeSettings,
  }) => {
    await updateKnowledgeSettings(request, {
      embeddingModel: "text-embedding-3-small",
      embeddingChatApiKeyId: null,
      rerankerModel: null,
      rerankerChatApiKeyId: null,
    });
  });
});
