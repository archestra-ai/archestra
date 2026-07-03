import { OrganizationModel } from "@/models";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import type { User } from "@/types";

describe("config routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: configRoutes } = await import("./config");
    await app.register(configRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns public config without authentication", async () => {
    const getAnalyticsStateSpy = vi.spyOn(
      OrganizationModel,
      "getAnalyticsState",
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/config/public",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      disableBasicAuth: expect.any(Boolean),
      disableInvitations: expect.any(Boolean),
      devAutoLoginEnabled: expect.any(Boolean),
      maintenanceMode: null,
      siteNotificationMessage: null,
      enterpriseCoreActive: expect.any(Boolean),
      analytics: {
        enabled: expect.any(Boolean),
        instanceId: expect.any(String),
        posthog: {
          key: expect.any(String),
          host: expect.any(String),
        },
      },
    });

    const cachedResponse = await app.inject({
      method: "GET",
      url: "/api/config/public",
    });

    expect(cachedResponse.statusCode).toBe(200);
    expect(cachedResponse.json().analytics.instanceId).toBe(
      response.json().analytics.instanceId,
    );
    expect(getAnalyticsStateSpy).toHaveBeenCalledTimes(1);
  });

  test("returns authenticated config with feature flags and provider base URLs", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/config",
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();

    expect(payload.enterpriseFeatures).toEqual({
      core: expect.any(Boolean),
      knowledgeBase: expect.any(Boolean),
      fullWhiteLabeling: expect.any(Boolean),
    });

    expect(payload.features).toMatchObject({
      orchestratorK8sRuntime: expect.any(Boolean),
      byosEnabled: expect.any(Boolean),
      azureOpenAiEntraIdEnabled: expect.any(Boolean),
      bedrockIamAuthEnabled: expect.any(Boolean),
      geminiVertexAiEnabled: expect.any(Boolean),
      mcpServerBaseImage: expect.any(String),
      orchestratorK8sNamespace: expect.any(String),
      isQuickstart: expect.any(Boolean),
      ngrokDomain: expect.any(String),
      virtualKeyDefaultExpirationSeconds: expect.any(Number),
      chatSecretScanEnabled: true,
    });
    expect(["permissive", "restrictive"]).toContain(
      payload.features.globalToolPolicy,
    );
    expect([null, "1", "2"]).toContain(payload.features.byosVaultKvVersion);
    expect(typeof payload.features.incomingEmail.enabled).toBe("boolean");
    expect(["string", "undefined"]).toContain(
      typeof payload.features.incomingEmail.provider,
    );
    expect(["string", "undefined"]).toContain(
      typeof payload.features.incomingEmail.displayName,
    );
    expect(["string", "undefined"]).toContain(
      typeof payload.features.incomingEmail.emailDomain,
    );
    expect(
      payload.features.mcpSandboxDomain === null ||
        typeof payload.features.mcpSandboxDomain === "string",
    ).toBe(true);

    expect(Object.keys(payload.providerBaseUrls).sort()).toEqual([
      "anthropic",
      "azure",
      "bedrock",
      "cerebras",
      "cohere",
      "deepseek",
      "gemini",
      "github-copilot",
      "groq",
      "minimax",
      "mistral",
      "ollama",
      "openai",
      "openrouter",
      "perplexity",
      "vllm",
      "xai",
      "zhipuai",
    ]);
    for (const value of Object.values(payload.providerBaseUrls)) {
      expect(value === null || typeof value === "string").toBe(true);
    }
  });
});
