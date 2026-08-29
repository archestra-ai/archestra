import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import { fetchCohereModels } from "./cohere";

const mockFetch = vi.fn();
// The shared test setup restores the real fetch after every test, so
// re-apply the mock before each one.
vi.stubGlobal("fetch", mockFetch);
beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

function mockModelsResponse(json: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(json),
  });
}

describe("fetchCohereModels", () => {
  test("surfaces chat models plus the KB-supported embed models tagged with their dimension", async () => {
    mockModelsResponse({
      models: [
        {
          name: "command-a-03-2025",
          endpoints: ["chat"],
          created_at: "2025-03-01",
        },
        { name: "embed-v4.0", endpoints: ["embed"], created_at: "2025-04-15" },
        // Offered for the Knowledge reranker through Cohere's native endpoint.
        { name: "embed-english-v2.0", endpoints: ["embed"] },
        { name: "rerank-v3.5", endpoints: ["rerank"] },
      ],
    });

    const models = await fetchCohereModels("k");

    const ids = models.map((model) => model.id);
    expect(ids).toContain("command-a-03-2025");
    expect(ids).not.toContain("embed-english-v2.0");
    expect(ids).toContain("rerank-v3.5");
    expect(models.find((model) => model.id === "rerank-v3.5")).toMatchObject({
      capabilities: { supportedEndpoints: ["/rerank"] },
    });

    const v4 = models.find((model) => model.id === "embed-v4.0");
    expect(v4).toMatchObject({
      provider: "cohere",
      displayName: "Cohere Embed v4",
      createdAt: "2025-04-15",
      capabilities: { embeddingDimensions: 1536 },
    });

    // Table entries the listing omitted are still offered (a key scoped to
    // embeddings sees the same set), without a createdAt.
    const english = models.find((model) => model.id === "embed-english-v3.0");
    expect(english).toMatchObject({
      capabilities: { embeddingDimensions: 1024 },
    });
    expect(english?.createdAt).toBeUndefined();
    expect(
      models.find((model) => model.id === "embed-english-light-v3.0")
        ?.capabilities?.embeddingDimensions,
    ).toBe(384);
  });
});
