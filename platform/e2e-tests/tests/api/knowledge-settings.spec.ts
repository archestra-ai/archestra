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

  // Clean up: reset to default
  test("cleanup: reset knowledge settings to defaults", async ({
    request,
    updateKnowledgeSettings,
  }) => {
    await updateKnowledgeSettings(request, {
      embeddingModel: "text-embedding-3-small",
      rerankerModel: null,
    });
  });
});
