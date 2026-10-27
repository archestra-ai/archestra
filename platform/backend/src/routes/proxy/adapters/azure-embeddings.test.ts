import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import config from "@/config";
import { useMswServer } from "@/test/msw";
import { azureEmbeddingsAdapterFactory } from "./azure";

// biome-ignore lint/correctness/useHookAtTopLevel: This registers Vitest lifecycle hooks, not React hooks.
const server = useMswServer();

describe("Azure embeddings native transport", () => {
  test.each([
    [
      "https://resource.example/openai/v1",
      "https://resource.example/openai/v1/embeddings",
      false,
    ],
    [
      "https://resource.example/openai",
      "https://resource.example/openai/deployments/search-vectors/embeddings",
      true,
    ],
  ])("uses Azure auth and the correct endpoint at %s", async (baseUrl, endpoint, versioned) => {
    config.llm.azure.apiVersion = "2024-10-21";
    server.use(
      http.post(endpoint, async ({ request }) => {
        expect(request.headers.get("api-key")).toBe("azure-test-key");
        expect(new URL(request.url).searchParams.get("api-version")).toBe(
          versioned ? "2024-10-21" : null,
        );
        expect(await request.json()).toMatchObject({
          model: "search-vectors",
          input: ["one", "two"],
          dimensions: 2,
          encoding_format: "float",
        });
        return HttpResponse.json({
          object: "list",
          model: "search-vectors",
          data: [
            { object: "embedding", index: 0, embedding: [0.1, 0.2] },
            { object: "embedding", index: 1, embedding: [0.3, 0.4] },
          ],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        });
      }),
    );
    const client = azureEmbeddingsAdapterFactory.createClient(
      "azure-test-key",
      { baseUrl, source: "api" },
    );
    const response = await azureEmbeddingsAdapterFactory.execute(client, {
      model: "search-vectors",
      input: ["one", "two"],
      dimensions: 2,
      encoding_format: "float",
    });
    expect(response.data.map((row) => row.embedding)).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });
});
