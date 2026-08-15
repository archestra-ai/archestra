import { CHATGPT_SUBSCRIPTION_LABEL } from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import {
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
} from "@/models";
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

describe("resolveProviderApiKey — cross-provider subscription marker", () => {
  // A ChatGPT (openai) marker inside an xai row's secret: reachable via
  // out-of-band secret rotation, which nothing re-validates. The openai
  // marker's encoded refresh token must never leave through the xai adapter
  // as a raw bearer, and substitution must not return an openai key to a
  // caller that will proceed as xai.
  const chatgptCredential = encodeOpenAiCodexCredential({
    refreshToken: "refresh-mismatch",
    accountId: "mismatch-account",
  });

  test("refuses the mismatched credential even for the key's own owner", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const secret = await makeSecret({
      secret: { apiKey: chatgptCredential },
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "xai",
      scope: "personal",
      userId: owner.id,
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: owner.id,
      provider: "xai",
    });

    expect(result.apiKey).toBeUndefined();
    expect(result.authRequired?.provider).toBe("xai");
  });

  test("refuses to substitute across providers for an agent-attached key", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const actingUser = await makeUser();
    const secret = await makeSecret({
      secret: { apiKey: chatgptCredential },
    });
    const ownerKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "xai",
      scope: "personal",
      userId: owner.id,
    });
    // The acting user owns a legitimate ChatGPT subscription key —
    // substitution by marker kind alone would wrongly return it here.
    const actingSecret = await makeSecret({
      secret: {
        apiKey: encodeOpenAiCodexCredential({
          refreshToken: "refresh-acting",
          accountId: "acting-account",
        }),
      },
    });
    await makeLlmProviderApiKey(org.id, actingSecret.id, {
      provider: "openai",
      scope: "personal",
      userId: actingUser.id,
    });

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: actingUser.id,
      provider: "xai",
      agentLlmApiKeyId: ownerKey.id,
    });

    expect(result.apiKey).toBeUndefined();
    expect(result.authRequired?.provider).toBe("xai");
  });
});

/**
 * A vLLM/Ollama key is a server, not an account: it only reaches the models its
 * own endpoint hosts. `vllm serve` runs one model per process, so an operator
 * hosting several models registers several endpoints under the one vLLM
 * provider — and every one of those models has to resolve to the endpoint that
 * actually serves it, whatever the ownership ladder would otherwise pick.
 */
describe("resolveProviderApiKey endpoint selection by model", () => {
  async function makeVllmModel(modelId: string) {
    return ModelModel.create({
      externalId: `vllm/${modelId}`,
      provider: "vllm",
      modelId,
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
  }

  test("routes to the vLLM endpoint that serves the requested model", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const [secretA, secretB] = await Promise.all([
      makeSecret({ secret: { apiKey: "EMPTY" } }),
      makeSecret({ secret: { apiKey: "EMPTY" } }),
    ]);
    // Created first, so the ownership ladder returns this one for every model.
    const serverA = await makeLlmProviderApiKey(org.id, secretA.id, {
      provider: "vllm",
      scope: "org",
      baseUrl: "http://vllm-a:8000/v1",
    });
    const serverB = await makeLlmProviderApiKey(org.id, secretB.id, {
      provider: "vllm",
      scope: "org",
      baseUrl: "http://vllm-b:8000/v1",
    });

    const llama = await makeVllmModel("meta-llama/Llama-3.1-8B-Instruct");
    const qwen = await makeVllmModel("Qwen/Qwen2.5-7B-Instruct");
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(serverA.id, [
      llama.id,
    ]);
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(serverB.id, [
      qwen.id,
    ]);

    const resolvedQwen = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "vllm",
      modelName: qwen.modelId,
    });
    expect(resolvedQwen.chatApiKeyId).toBe(serverB.id);
    expect(resolvedQwen.baseUrl).toBe("http://vllm-b:8000/v1");

    // The other server's model still resolves to the key the ladder picks.
    const resolvedLlama = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "vllm",
      modelName: llama.modelId,
    });
    expect(resolvedLlama.chatApiKeyId).toBe(serverA.id);
    expect(resolvedLlama.baseUrl).toBe("http://vllm-a:8000/v1");
  });

  test("overrides an agent-pinned key that does not serve the model", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const [secretA, secretB] = await Promise.all([
      makeSecret({ secret: { apiKey: "EMPTY" } }),
      makeSecret({ secret: { apiKey: "EMPTY" } }),
    ]);
    const serverA = await makeLlmProviderApiKey(org.id, secretA.id, {
      provider: "vllm",
      scope: "org",
      baseUrl: "http://vllm-a:8000/v1",
    });
    const serverB = await makeLlmProviderApiKey(org.id, secretB.id, {
      provider: "vllm",
      scope: "org",
      baseUrl: "http://vllm-b:8000/v1",
    });
    const qwen = await makeVllmModel("Qwen/Qwen2.5-7B-Instruct");
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(serverB.id, [
      qwen.id,
    ]);

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "vllm",
      agentLlmApiKeyId: serverA.id,
      modelName: qwen.modelId,
    });

    expect(result.chatApiKeyId).toBe(serverB.id);
    expect(result.baseUrl).toBe("http://vllm-b:8000/v1");
  });

  test("never crosses a visibility boundary to reach a serving endpoint", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const otherUser = await makeUser();
    const otherTeam = await makeTeam(org.id, otherUser.id);
    const [secretA, secretB] = await Promise.all([
      makeSecret({ secret: { apiKey: "EMPTY" } }),
      makeSecret({ secret: { apiKey: "EMPTY" } }),
    ]);
    const orgServer = await makeLlmProviderApiKey(org.id, secretA.id, {
      provider: "vllm",
      scope: "org",
      baseUrl: "http://vllm-a:8000/v1",
    });
    const foreignServer = await makeLlmProviderApiKey(org.id, secretB.id, {
      provider: "vllm",
      scope: "team",
      teamId: otherTeam.id,
      baseUrl: "http://vllm-restricted:8000/v1",
    });
    const qwen = await makeVllmModel("Qwen/Qwen2.5-7B-Instruct");
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(foreignServer.id, [
      qwen.id,
    ]);

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "vllm",
      modelName: qwen.modelId,
    });

    expect(result.chatApiKeyId).toBe(orgServer.id);
    expect(result.baseUrl).toBe("http://vllm-a:8000/v1");
  });

  test("leaves credential-style providers on the ownership ladder", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const [personalSecret, orgSecret] = await Promise.all([
      makeSecret({ secret: { apiKey: "sk-personal" } }),
      makeSecret({ secret: { apiKey: "sk-org" } }),
    ]);
    const personalKey = await makeLlmProviderApiKey(org.id, personalSecret.id, {
      provider: "openai",
      scope: "personal",
      userId: user.id,
    });
    const orgKey = await makeLlmProviderApiKey(org.id, orgSecret.id, {
      provider: "openai",
      scope: "org",
    });
    // Only the org key has synced this model, but for a credential provider
    // both keys reach the same catalog — moving spend to another account
    // because of a stale sync would be the wrong trade.
    const model = await ModelModel.create({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(orgKey.id, [
      model.id,
    ]);

    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "openai",
      modelName: "gpt-4o",
    });

    expect(result.chatApiKeyId).toBe(personalKey.id);
    expect(result.apiKey).toBe("sk-personal");
  });

  test("keeps the resolved key for a model no endpoint reports", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "EMPTY" } });
    const server = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "vllm",
      scope: "org",
      baseUrl: "http://vllm-a:8000/v1",
    });

    // A model the operator has just deployed but not synced — resolution has
    // nothing to route by and must not strand the request.
    const result = await resolveProviderApiKey({
      organizationId: org.id,
      userId: user.id,
      provider: "vllm",
      modelName: "not-synced-anywhere",
    });

    expect(result.chatApiKeyId).toBe(server.id);
    expect(result.baseUrl).toBe("http://vllm-a:8000/v1");
  });
});
