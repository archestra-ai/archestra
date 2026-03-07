import { SupportedProviders } from "@shared";
import { expect, test } from "./fixtures";

test.describe("Config endpoint", () => {
  test("GET /api/config returns features and providerBaseUrls for authenticated user", async ({
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
      enterpriseFeatures: Record<string, unknown>;
    };

    // Verify top-level structure
    expect(data).toHaveProperty("features");
    expect(data).toHaveProperty("providerBaseUrls");
    expect(data).toHaveProperty("enterpriseFeatures");

    // Verify features has expected keys
    const features = data.features;
    expect(features).toHaveProperty("orchestratorK8sRuntime");
    expect(features).toHaveProperty("byosEnabled");
    expect(features).toHaveProperty("globalToolPolicy");
    expect(features).toHaveProperty("incomingEmail");
    expect(features).toHaveProperty("knowledgeGraph");
    expect(features).toHaveProperty("mcpServerBaseImage");
    expect(features).toHaveProperty("virtualKeyDefaultExpirationSeconds");

    // Verify enterpriseFeatures has expected keys
    const enterpriseFeatures = data.enterpriseFeatures;
    expect(enterpriseFeatures).toHaveProperty("core");
    expect(enterpriseFeatures).toHaveProperty("fullWhiteLabeling");

    // Verify providerBaseUrls has an entry for every supported provider
    const urls = data.providerBaseUrls;
    for (const provider of SupportedProviders) {
      expect(urls).toHaveProperty(provider);
    }
  });
});
