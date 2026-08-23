/**
 * LLM resolution for the policy-configuration subagent, against REAL
 * `@/utils/llm-resolution` and real database rows.
 *
 * The rest of this subagent's tests mock the resolution module wholesale,
 * which is exactly what let "Configure with Subagent" ship failing on every
 * tool: the service used to read the built-in agent's pinned selection through
 * `resolveConfiguredAgentLlm`, an ownership-blind helper that deliberately
 * returns a selection with NO credential when the pinned key belongs to an
 * individual (a ChatGPT/Codex or Claude subscription, a Copilot token) and
 * expects its caller to finish the job. A mocked resolver can't reproduce
 * that, so these cases live here.
 */
import {
  BUILT_IN_AGENT_IDS,
  SupportedProvidersSchema,
} from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import { LlmProviderApiKeyModelLinkModel, ModelModel } from "@/models";
import AgentModel from "@/models/agent";
import { encodeOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { describe, expect, test } from "@/test";
import { PolicyConfigurationService } from "./policy-configuration";

// Boundary mock only: the model factory would otherwise reach a provider.
// Resolution itself — the code under test — runs for real.
vi.mock("@/clients/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients/llm-client")>();
  return { ...actual, createLLMModel: vi.fn() };
});

async function makeOpenAiModel(modelId: string) {
  return ModelModel.upsert({
    externalId: `openai/${modelId}`,
    provider: "openai",
    modelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
}

/** The org's policy-configuration subagent, pinned to a model and a key. */
async function makePolicyConfigAgent(params: {
  organizationId: string;
  llmApiKeyId: string | null;
  modelId: string | null;
}) {
  return AgentModel.create({
    name: "Policy Configuration Subagent",
    organizationId: params.organizationId,
    agentType: "agent",
    scope: "org",
    systemPrompt: "You are a policy configuration subagent.",
    builtInAgentConfig: {
      name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
      autoConfigureOnToolDiscovery: false,
    },
    llmApiKeyId: params.llmApiKeyId,
    modelId: params.modelId,
    teams: [],
    labels: [],
    knowledgeBaseIds: [],
    connectorIds: [],
  });
}

describe("PolicyConfigurationService.resolveLlm (real resolution)", () => {
  test("resolves a subscription credential for the user who owns it", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const credential = encodeOpenAiCodexCredential({
      refreshToken: "refresh-token",
      accountId: "account-id",
    });
    const secret = await makeSecret({ secret: { apiKey: credential } });
    // A connected subscription is always a personal key owned by one user.
    const key = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      scope: "personal",
      userId: user.id,
    });
    const model = await makeOpenAiModel("gpt-5-codex");
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    await makePolicyConfigAgent({
      organizationId: org.id,
      llmApiKeyId: key.id,
      modelId: model.id,
    });

    const resolved = await new PolicyConfigurationService().resolveLlm({
      organizationId: org.id,
      userId: user.id,
    });

    // The regression: reading the agent's pinned selection alone yielded
    // `{ apiKey: undefined }` here — non-null, so the route's "is an LLM
    // configured?" check passed, and then every tool failed its own call.
    expect(resolved?.apiKey).toBe(credential);
    expect(resolved?.modelName).toBe("gpt-5-codex");
    // The proxy needs the row: Codex refresh tokens rotate on redemption.
    expect(resolved?.chatApiKeyId).toBe(key.id);
  });

  test("resolves the org's usable key when the agent pins only a model", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "sk-org-key" } });
    const key = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      scope: "org",
    });
    const model = await makeOpenAiModel("gpt-4.1");
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    await makePolicyConfigAgent({
      organizationId: org.id,
      llmApiKeyId: null,
      modelId: model.id,
    });

    const resolved = await new PolicyConfigurationService().resolveLlm({
      organizationId: org.id,
      userId: user.id,
    });

    expect(resolved?.apiKey).toBe("sk-org-key");
    expect(resolved?.modelName).toBe("gpt-4.1");
  });

  test("returns null when nothing resolves a credential", async ({
    makeOrganization,
    makeUser,
  }) => {
    for (const provider of SupportedProvidersSchema.options) {
      const providerConfig = config.chat[provider as keyof typeof config.chat];
      if (
        typeof providerConfig === "object" &&
        providerConfig !== null &&
        "apiKey" in providerConfig
      ) {
        providerConfig.apiKey = "";
      }
    }

    const org = await makeOrganization();
    const user = await makeUser();
    await makePolicyConfigAgent({
      organizationId: org.id,
      llmApiKeyId: null,
      modelId: null,
    });

    const resolved = await new PolicyConfigurationService().resolveLlm({
      organizationId: org.id,
      userId: user.id,
    });

    // Null is what turns into the actionable "configure an LLM API key" 400,
    // instead of N tools each failing on a missing credential.
    expect(resolved).toBeNull();
  });
});
