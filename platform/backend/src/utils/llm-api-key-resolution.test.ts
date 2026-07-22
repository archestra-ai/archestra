import { CHATGPT_SUBSCRIPTION_LABEL } from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import { LlmProviderApiKeyModel } from "@/models";
import { encodeOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { beforeEach, describe, expect, test } from "@/test";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";

const mockIsAzureOpenAiEntraIdEnabled = vi.hoisted(() => vi.fn(() => false));

vi.mock("@/clients/azure-openai-credentials", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/clients/azure-openai-credentials")>();
  return {
    ...actual,
    isAzureOpenAiEntraIdEnabled: mockIsAzureOpenAiEntraIdEnabled,
  };
});

describe("resolveProviderApiKey", () => {
  beforeEach(() => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);
  });

  test("resolves personal key for user", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "sk-personal-key" } });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      scope: "personal",
      userId: user.id,
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "openai",
    });

    expect(result.apiKey).toBe("sk-personal-key");
    expect(result.source).toBe("personal");
    expect(result.chatApiKeyId).toBeDefined();
    expect(result.baseUrl).toBeNull();
  });

  test("resolves org key when no user provided", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-org-key" } });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
      scope: "org",
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      provider: "anthropic",
    });

    expect(result.apiKey).toBe("sk-org-key");
    expect(result.source).toBe("org");
    expect(result.chatApiKeyId).toBeDefined();
  });

  test("returns baseUrl when key has custom base URL", async ({
    makeOrganization,
    makeUser,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "sk-custom-base" } });

    const { LlmProviderApiKeyModel } = await import("@/models");
    await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: secret.id,
      name: "Custom Base URL Key",
      provider: "openai",
      scope: "personal",
      userId: user.id,
      baseUrl: "https://my-proxy.example.com/v1",
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "openai",
    });

    expect(result.apiKey).toBe("sk-custom-base");
    expect(result.baseUrl).toBe("https://my-proxy.example.com/v1");
  });

  test("prefers inferenceBaseUrl over discovery baseUrl for runtime calls", async ({
    makeOrganization,
    makeUser,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "sk-runtime-base" } });

    const { LlmProviderApiKeyModel } = await import("@/models");
    await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: secret.id,
      name: "Azure Runtime URL Key",
      provider: "azure",
      scope: "personal",
      userId: user.id,
      baseUrl: "https://discovery.example.com/openai",
      inferenceBaseUrl: "https://runtime.example.com/openai",
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "azure",
    });

    expect(result.apiKey).toBe("sk-runtime-base");
    expect(result.baseUrl).toBe("https://runtime.example.com/openai");
  });

  test("resolves an explicit keyless Azure conversation key", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeAgent,
    makeConversation,
  }) => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(true);

    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ name: "Azure Chat Agent", teams: [] });
    const fallbackSecret = await makeSecret({
      secret: { apiKey: "sk-fallback" },
    });

    await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: fallbackSecret.id,
      name: "Fallback Azure Key",
      provider: "azure",
      scope: "org",
      baseUrl: "https://fallback.example.com/openai",
      inferenceBaseUrl: "https://fallback-runtime.example.com/openai",
    });
    const selectedKey = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: null,
      name: "Selected Keyless Azure Key",
      provider: "azure",
      scope: "org",
      baseUrl: "https://discovery.example.com/openai",
      inferenceBaseUrl: "https://runtime.example.com/openai",
    });
    const conversation = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
      chatApiKeyId: selectedKey.id,
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "azure",
      conversationId: conversation.id,
    });

    expect(result.apiKey).toBeUndefined();
    expect(result.chatApiKeyId).toBe(selectedKey.id);
    expect(result.baseUrl).toBe("https://runtime.example.com/openai");
  });

  test("resolves an explicit keyless Azure agent key", async ({
    makeOrganization,
    makeUser,
    makeSecret,
  }) => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(true);

    const org = await makeOrganization();
    const user = await makeUser();
    const fallbackSecret = await makeSecret({
      secret: { apiKey: "sk-fallback" },
    });

    await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: fallbackSecret.id,
      name: "Fallback Azure Key",
      provider: "azure",
      scope: "org",
      baseUrl: "https://fallback.example.com/openai",
      inferenceBaseUrl: "https://fallback-runtime.example.com/openai",
    });
    const agentKey = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: null,
      name: "Agent Keyless Azure Key",
      provider: "azure",
      scope: "org",
      baseUrl: "https://discovery.example.com/openai",
      inferenceBaseUrl: "https://runtime.example.com/openai",
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "azure",
      agentLlmApiKeyId: agentKey.id,
    });

    expect(result.apiKey).toBeUndefined();
    expect(result.chatApiKeyId).toBe(agentKey.id);
    expect(result.baseUrl).toBe("https://runtime.example.com/openai");
  });

  test("returns undefined apiKey when no key configured and no env var", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "cerebras",
    });

    expect(result.source).toBe("environment");
    expect(result.baseUrl).toBeNull();
  });

  test("personal key takes priority over org", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const orgSecret = await makeSecret({ secret: { apiKey: "sk-org-wide" } });
    await makeLlmProviderApiKey(org.id, orgSecret.id, {
      provider: "anthropic",
      scope: "org",
    });

    const personalSecret = await makeSecret({
      secret: { apiKey: "sk-personal" },
    });
    await makeLlmProviderApiKey(org.id, personalSecret.id, {
      provider: "anthropic",
      scope: "personal",
      userId: user.id,
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "anthropic",
    });

    expect(result.apiKey).toBe("sk-personal");
    expect(result.source).toBe("personal");
  });

  test("team key takes priority over org when user is in team", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeTeamMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id, { name: "Test Team" });
    await makeTeamMember(team.id, user.id);

    const orgSecret = await makeSecret({ secret: { apiKey: "sk-org-wide" } });
    await makeLlmProviderApiKey(org.id, orgSecret.id, {
      provider: "openai",
      scope: "org",
    });

    const teamSecret = await makeSecret({ secret: { apiKey: "sk-team" } });
    await makeLlmProviderApiKey(org.id, teamSecret.id, {
      provider: "openai",
      scope: "team",
      teamId: team.id,
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "openai",
    });

    expect(result.apiKey).toBe("sk-team");
    expect(result.source).toBe("team");
  });

  test("supports legacy secret formats (anthropicApiKey)", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({
      secret: { anthropicApiKey: "sk-legacy-key" },
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
      scope: "org",
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      provider: "anthropic",
    });

    expect(result.apiKey).toBe("sk-legacy-key");
  });
});

describe("resolveProviderApiKey — ChatGPT-subscription (Codex) per-user guard", () => {
  const codexCredential = (accountId: string) =>
    encodeOpenAiCodexCredential({
      refreshToken: `refresh-${accountId}`,
      accountId,
    });

  test("serves an agent-attached subscription key to its owner", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const secret = await makeSecret({
      secret: { apiKey: codexCredential("owner-account") },
    });
    const ownerKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      scope: "personal",
      userId: owner.id,
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: owner.id,
      provider: "openai",
      agentLlmApiKeyId: ownerKey.id,
    });

    expect(result.apiKey).toBe(codexCredential("owner-account"));
    expect(result.chatApiKeyId).toBe(ownerKey.id);
  });

  test("substitutes the acting user's own subscription for another user's agent-attached key", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const otherUser = await makeUser();
    const ownerSecret = await makeSecret({
      secret: { apiKey: codexCredential("owner-account") },
    });
    const ownerKey = await makeLlmProviderApiKey(org.id, ownerSecret.id, {
      provider: "openai",
      scope: "personal",
      userId: owner.id,
    });
    const otherSecret = await makeSecret({
      secret: { apiKey: codexCredential("other-account") },
    });
    const otherKey = await makeLlmProviderApiKey(org.id, otherSecret.id, {
      provider: "openai",
      scope: "personal",
      userId: otherUser.id,
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: otherUser.id,
      provider: "openai",
      agentLlmApiKeyId: ownerKey.id,
    });

    expect(result.apiKey).toBe(codexCredential("other-account"));
    expect(result.chatApiKeyId).toBe(otherKey.id);
    expect(result.source).toBe("personal");
  });

  test("prompts to connect instead of serving another user's subscription", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const otherUser = await makeUser();
    const ownerSecret = await makeSecret({
      secret: { apiKey: codexCredential("owner-account") },
    });
    const ownerKey = await makeLlmProviderApiKey(org.id, ownerSecret.id, {
      provider: "openai",
      scope: "personal",
      userId: owner.id,
    });
    // A plain personal OpenAI API key is NOT a subscription — the agent is
    // pinned to subscription auth, so it must not be silently swapped in.
    const plainSecret = await makeSecret({
      secret: { apiKey: "sk-other-plain" },
    });
    await makeLlmProviderApiKey(org.id, plainSecret.id, {
      provider: "openai",
      scope: "personal",
      userId: otherUser.id,
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: otherUser.id,
      provider: "openai",
      agentLlmApiKeyId: ownerKey.id,
    });

    expect(result.apiKey).toBeUndefined();
    expect(result.authRequired).toEqual({
      provider: "openai",
      providerLabel: CHATGPT_SUBSCRIPTION_LABEL,
    });
  });

  test("never serves a subscription credential smuggled into an org-scope key", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    // The routes reject non-personal subscription keys; create through the
    // model to simulate a smuggled credential and pin the serve-time backstop.
    const secret = await makeSecret({
      secret: { apiKey: codexCredential("smuggled-account") },
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      scope: "org",
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      provider: "openai",
    });

    expect(result.apiKey).toBeUndefined();
    expect(result.authRequired).toBeDefined();
  });

  test("ignores a subscription credential in the provider env var", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    config.chat.openai.apiKey = codexCredential("env-account");

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      provider: "openai",
    });

    expect(result.apiKey).toBeUndefined();
  });
});
