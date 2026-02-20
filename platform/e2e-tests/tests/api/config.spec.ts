import { expect, test } from "./fixtures";

test.describe("Config endpoint", () => {
  test("GET /api/config returns features and providerBaseUrls", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/config",
    });

    const data = (await response.json()) as {
      features: Record<string, unknown>;
      providerBaseUrls: Record<string, string | null>;
    };

    // Verify top-level structure
    expect(data).toHaveProperty("features");
    expect(data).toHaveProperty("providerBaseUrls");

    // Verify features has expected keys
    const features = data.features;
    expect(features).toHaveProperty("orchestrator-k8s-runtime");
    expect(features).toHaveProperty("byosEnabled");
    expect(features).toHaveProperty("globalToolPolicy");
    expect(features).toHaveProperty("browserStreamingEnabled");
    expect(features).toHaveProperty("incomingEmail");
    expect(features).toHaveProperty("knowledgeGraph");
    expect(features).toHaveProperty("mcpServerBaseImage");
    expect(features).toHaveProperty("chatops");

    // Verify providerBaseUrls has all providers
    const urls = data.providerBaseUrls;
    expect(urls).toHaveProperty("openai");
    expect(urls).toHaveProperty("anthropic");
    expect(urls).toHaveProperty("gemini");
    expect(urls).toHaveProperty("ollama");
    expect(urls).toHaveProperty("vllm");
    expect(urls).toHaveProperty("bedrock");
    expect(urls).toHaveProperty("cohere");
    expect(urls).toHaveProperty("cerebras");
    expect(urls).toHaveProperty("mistral");
    expect(urls).toHaveProperty("perplexity");
    expect(urls).toHaveProperty("zhipuai");
  });
});
