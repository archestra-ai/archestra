import { SupportedProviders } from "@shared";
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
    expect(features).toHaveProperty("virtualKeyDefaultExpirationSeconds");

    // Verify providerBaseUrls has an entry for every supported provider
    const urls = data.providerBaseUrls;
    for (const provider of SupportedProviders) {
      expect(urls).toHaveProperty(provider);
    }
  });
});
