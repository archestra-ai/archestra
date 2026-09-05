import type { SupportedProvider } from "@archestra/shared";
import config from "@/config";
import {
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  TeamTokenModel,
  UserCredentialModel,
  VirtualApiKeyModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent, ResolvedAgentRuntime, User } from "@/types";
import { buildAgentRunLaunchSpec } from "./launch-spec";

describe("buildAgentRunLaunchSpec", () => {
  let previousPlatformBaseUrl: string;

  beforeEach(() => {
    previousPlatformBaseUrl = config.agentRuntime.platformBaseUrl;
    config.agentRuntime.platformBaseUrl = "https://platform.example.test";
  });

  afterEach(() => {
    config.agentRuntime.platformBaseUrl = previousPlatformBaseUrl;
  });

  test("routes the Agent's selected model through its scoped model router", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
    makeAgent,
  }) => {
    const setup = await makeConfiguredAgent({
      provider: "gemini",
      makeOrganization,
      makeAdmin,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
      makeAgent,
    });
    const runId = crypto.randomUUID();

    const { spec, virtualApiKeyId } = await buildAgentRunLaunchSpec({
      runtime: {
        ...runtime(setup.agent, "openai_responses"),
        environment: [
          { key: "CUSTOM_SETTING", value: "preserved" },
          { key: "OPENAI_BASE_URL", value: "https://bypass.invalid" },
          { key: "ARCHESTRA_MCP_GATEWAY_TOKEN", value: "bypass-token" },
          { key: "ARCHESTRA_AGENT_RUNTIME_RUN_ID", value: "bypass-run" },
        ],
      },
      taskId: crypto.randomUUID(),
      runId,
      agentId: setup.agent.id,
      actor: {
        id: setup.user.id,
        kind: "user",
        organizationId: setup.agent.organizationId,
      },
      organizationId: setup.agent.organizationId,
      runtimeScope: "agent-tests",
      effectiveNetworkPolicy: { source: "built_in", policy: null },
      appName: "Example AI",
      runMode: "one_shot",
      task: "Inspect the repository and report the result.",
    });

    expect(spec.env).toMatchObject({
      CUSTOM_SETTING: "preserved",
      ARCHESTRA_AGENT_RUNTIME_MODEL: "gemini:selected-model",
      ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: "selected-model",
      ARCHESTRA_AGENT_RUNTIME_MODEL_PROVIDER: "gemini",
      ARCHESTRA_AGENT_RUNTIME_MODEL_OUTPUT_LENGTH: "16384",
      ARCHESTRA_AGENT_RUNTIME_RUN_ID: runId,
      ARCHESTRA_LLM_PROXY_PROTOCOL: "openai_responses",
      ARCHESTRA_LLM_PROXY_URL: `https://platform.example.test/v1/model-router/${setup.agent.id}`,
      OPENAI_BASE_URL: `https://platform.example.test/v1/model-router/${setup.agent.id}`,
      ARCHESTRA_MCP_GATEWAY_URL: `https://platform.example.test/v1/mcp/${setup.agent.id}`,
      ARCHESTRA_AGENT_RUNTIME_BANNER:
        "Example AI\nSecure access to your AI tools",
    });
    expect(spec.env.ARCHESTRA_AGENT_RUNTIME_BANNER).not.toContain("⣾⣿");
    expect(spec.secretEnv.OPENAI_API_KEY).toMatch(/^arch_/);
    expect(spec.secretEnv.OPENAI_API_KEY).not.toBe("upstream-secret");
    expect(spec.env.OPENAI_BASE_URL).not.toBe("https://bypass.invalid");
    expect(spec.env).not.toHaveProperty("ARCHESTRA_MCP_GATEWAY_TOKEN");

    const virtualKey = await VirtualApiKeyModel.findById(virtualApiKeyId);
    expect(virtualKey?.scope).toBe("personal");
    expect(virtualKey?.authorId).toBe(setup.user.id);
  });

  test("routes a Gemini Vertex AI run through its keyless stored credential", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeAgent,
  }) => {
    config.llm.gemini.vertexAi.enabled = true;
    config.llm.gemini.vertexAi.project = "test-project";

    const organization = await makeOrganization();
    const user = await makeAdmin();
    await makeMember(user.id, organization.id, { role: "admin" });
    const providerKey = await LlmProviderApiKeyModel.create({
      organizationId: organization.id,
      secretId: null,
      name: "Vertex AI workload identity",
      provider: "gemini",
      scope: "org",
      userId: null,
      teamId: null,
      baseUrl: null,
      inferenceBaseUrl: null,
    });
    const model = await ModelModel.create({
      externalId: "gemini/keyless-model",
      provider: "gemini",
      modelId: "keyless-model",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(providerKey.id, [
      model.id,
    ]);
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: user.id,
      agentType: "agent",
      modelId: model.id,
      llmApiKeyId: providerKey.id,
    });

    const { spec, virtualApiKeyId } = await buildAgentRunLaunchSpec({
      runtime: runtime(agent, "openai_responses"),
      taskId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      agentId: agent.id,
      actor: {
        id: user.id,
        kind: "user",
        organizationId: organization.id,
      },
      organizationId: organization.id,
      runtimeScope: "agent-tests",
      effectiveNetworkPolicy: { source: "built_in", policy: null },
      appName: "Archestra",
      runMode: "one_shot",
    });

    expect(spec.secretEnv.OPENAI_API_KEY).toMatch(/^arch_/);
    const providerVirtualKeys = await VirtualApiKeyModel.findByProviderApiKeyId(
      providerKey.id,
    );
    expect(providerVirtualKeys.map(({ id }) => id)).toContain(virtualApiKeyId);
  });

  test("uses organization-scoped access for a system run actor", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
    makeAgent,
  }) => {
    const setup = await makeConfiguredAgent({
      provider: "gemini",
      makeOrganization,
      makeAdmin,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
      makeAgent,
    });
    await TeamTokenModel.create({
      organizationId: setup.agent.organizationId,
      isOrganizationToken: true,
      name: "Automation token",
    });

    const { spec, virtualApiKeyId } = await buildAgentRunLaunchSpec({
      runtime: runtime(setup.agent, "openai_responses"),
      taskId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      agentId: setup.agent.id,
      actor: {
        id: "system",
        kind: "system",
        organizationId: setup.agent.organizationId,
      },
      organizationId: setup.agent.organizationId,
      runtimeScope: "agent-tests",
      effectiveNetworkPolicy: { source: "built_in", policy: null },
      appName: "Archestra",
      runMode: "one_shot",
      task: "Process an incoming message.",
    });

    expect(spec.secretEnv.ARCHESTRA_MCP_GATEWAY_TOKEN).toEqual(
      expect.any(String),
    );
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    expect(config.enterpriseFeatures.fullWhiteLabeling).toBe(true);
    expect(spec.env.ARCHESTRA_AGENT_RUNTIME_BANNER).toBe(
      "Archestra\nSecure access to your AI tools",
    );
    // SPDX-SnippetEnd
    const virtualKey = await VirtualApiKeyModel.findById(virtualApiKeyId);
    expect(virtualKey).toMatchObject({ scope: "org", authorId: null });
  });

  test("uses the Agent-scoped Anthropic endpoint for an Anthropic image", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
    makeAgent,
  }) => {
    const setup = await makeConfiguredAgent({
      provider: "anthropic",
      makeOrganization,
      makeAdmin,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
      makeAgent,
    });

    const { spec } = await buildAgentRunLaunchSpec({
      runtime: runtime(setup.agent, "anthropic"),
      taskId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      agentId: setup.agent.id,
      actor: {
        id: setup.user.id,
        kind: "user",
        organizationId: setup.agent.organizationId,
      },
      organizationId: setup.agent.organizationId,
      runtimeScope: "agent-tests",
      effectiveNetworkPolicy: { source: "built_in", policy: null },
      appName: "Archestra",
      runMode: "one_shot",
    });

    expect(spec.env.ARCHESTRA_LLM_PROXY_URL).toBe(
      `https://platform.example.test/v1/anthropic/${setup.agent.id}`,
    );
    expect(spec.env.ARCHESTRA_AGENT_RUNTIME_MODEL).toBe("selected-model");
    expect(spec.env.ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL).toBe(
      "selected-model",
    );
    expect(spec.secretEnv.ANTHROPIC_API_KEY).toMatch(/^arch_/);
  });

  test("rejects an image protocol that cannot serve the selected provider", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
    makeAgent,
  }) => {
    const setup = await makeConfiguredAgent({
      provider: "gemini",
      makeOrganization,
      makeAdmin,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
      makeAgent,
    });

    await expect(
      buildAgentRunLaunchSpec({
        runtime: runtime(setup.agent, "anthropic"),
        taskId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        agentId: setup.agent.id,
        actor: {
          id: setup.user.id,
          kind: "user",
          organizationId: setup.agent.organizationId,
        },
        organizationId: setup.agent.organizationId,
        runtimeScope: "agent-tests",
        effectiveNetworkPolicy: { source: "built_in", policy: null },
        appName: "Archestra",
        runMode: "one_shot",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("rejects a Responses-only model for a Chat Completions image", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
    makeAgent,
  }) => {
    const setup = await makeConfiguredAgent({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      makeOrganization,
      makeAdmin,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
      makeAgent,
    });

    await expect(
      buildAgentRunLaunchSpec({
        runtime: runtime(setup.agent, "openai_chat"),
        taskId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        agentId: setup.agent.id,
        actor: {
          id: setup.user.id,
          kind: "user",
          organizationId: setup.agent.organizationId,
        },
        organizationId: setup.agent.organizationId,
        runtimeScope: "agent-tests",
        effectiveNetworkPolicy: { source: "built_in", policy: null },
        appName: "Archestra",
        runMode: "one_shot",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("requires the Responses API"),
    });
  });

  test("aliases a declared GitHub token for native gh clients", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
    makeAgent,
  }) => {
    const setup = await makeConfiguredAgent({
      provider: "openai",
      makeOrganization,
      makeAdmin,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
      makeAgent,
    });
    const configuredRuntime = runtime(setup.agent, "openai_responses");
    configuredRuntime.credentials = [
      {
        key: "GITHUB_TOKEN",
        scope: "per_user",
        label: "GitHub token",
        required: true,
      },
    ];
    await UserCredentialModel.upsert({
      organizationId: setup.agent.organizationId,
      userId: setup.user.id,
      agentId: setup.agent.id,
      key: "GITHUB_TOKEN",
      value: "github-token",
    });

    const { spec } = await buildAgentRunLaunchSpec({
      runtime: configuredRuntime,
      taskId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      agentId: setup.agent.id,
      actor: {
        id: setup.user.id,
        kind: "user",
        organizationId: setup.agent.organizationId,
      },
      organizationId: setup.agent.organizationId,
      runtimeScope: "agent-tests",
      effectiveNetworkPolicy: { source: "built_in", policy: null },
      appName: "Archestra",
      runMode: "one_shot",
    });

    expect(spec.secretEnv.GITHUB_TOKEN).toBe("github-token");
    expect(spec.secretEnv.GH_TOKEN).toBe("github-token");
  });

  test("scopes a personal Claude subscription token to the Claude Code runtime", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
    makeAgent,
  }) => {
    const setup = await makeConfiguredAgent({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      contextLength: 1_000_000,
      makeOrganization,
      makeAdmin,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
      makeAgent,
    });
    const configuredRuntime = runtime(setup.agent, "anthropic");
    configuredRuntime.command = ["archestra-claude-code"];
    configuredRuntime.credentials = [
      {
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        scope: "per_user",
        label: "Claude Code subscription token",
        required: false,
      },
    ];
    await UserCredentialModel.upsert({
      organizationId: setup.agent.organizationId,
      userId: setup.user.id,
      agentId: setup.agent.id,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "claude-subscription-token",
    });
    const taskId = crypto.randomUUID();
    const runId = crypto.randomUUID();

    const { spec, virtualApiKeyId } = await buildAgentRunLaunchSpec({
      runtime: configuredRuntime,
      taskId,
      runId,
      agentId: setup.agent.id,
      actor: {
        id: setup.user.id,
        kind: "user",
        organizationId: setup.agent.organizationId,
      },
      organizationId: setup.agent.organizationId,
      runtimeScope: "agent-tests",
      effectiveNetworkPolicy: { source: "built_in", policy: null },
      appName: "Archestra",
      runMode: "one_shot",
    });

    expect(spec.secretEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "claude-subscription-token",
    );
    expect(spec.secretEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(spec.secretEnv).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(spec.secretEnv).not.toHaveProperty("OPENAI_API_KEY");
    expect(spec.secretEnv.ANTHROPIC_CUSTOM_HEADERS).toContain(
      `X-Archestra-Run-Id: ${taskId}`,
    );
    expect(spec.secretEnv.ANTHROPIC_CUSTOM_HEADERS).toContain(
      `X-Archestra-Session-Id: ${taskId}`,
    );
    expect(spec.secretEnv.ANTHROPIC_CUSTOM_HEADERS).toMatch(
      /X-Archestra-Virtual-Key: arch_/,
    );
    expect(spec.env.ARCHESTRA_AGENT_RUNTIME_MODEL).toBe("claude-opus-4-8");
    expect(spec.env.ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL).toBe(
      "claude-opus-4-8[1m]",
    );
    expect(spec.env.ARCHESTRA_AGENT_RUNTIME_MODEL_CONTEXT_LENGTH).toBe(
      "1000000",
    );
    expect(spec.env.ARCHESTRA_AGENT_RUNTIME_MODEL_OUTPUT_LENGTH).toBe("16384");
    expect(spec.env.ARCHESTRA_AGENT_RUNTIME_RUN_ID).toBe(runId);

    const virtualKey = await VirtualApiKeyModel.findById(virtualApiKeyId);
    expect(virtualKey?.keyType).toBe("passthrough");
    expect(virtualKey?.scope).toBe("personal");
    expect(virtualKey?.authorId).toBe(setup.user.id);
  });

  test("never falls back to Anthropic API billing for Claude Code", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
    makeAgent,
  }) => {
    const setup = await makeConfiguredAgent({
      provider: "anthropic",
      makeOrganization,
      makeAdmin,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
      makeAgent,
    });
    const configuredRuntime = runtime(setup.agent, "anthropic");
    configuredRuntime.command = ["archestra-claude-code"];

    await expect(
      buildAgentRunLaunchSpec({
        runtime: configuredRuntime,
        taskId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        agentId: setup.agent.id,
        actor: {
          id: setup.user.id,
          kind: "user",
          organizationId: setup.agent.organizationId,
        },
        organizationId: setup.agent.organizationId,
        runtimeScope: "agent-tests",
        effectiveNetworkPolicy: { source: "built_in", policy: null },
        appName: "Archestra",
        runMode: "interactive",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("never falls back"),
    });
  });

  test("uses the acting user's ChatGPT subscription for maintained Codex runtimes", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
    makeAgent,
  }) => {
    const setup = await makeConfiguredAgent({
      provider: "openai",
      makeOrganization,
      makeAdmin,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
      makeAgent,
    });
    const subscriptionSecret = await makeSecret({
      secret: { apiKey: "chatgpt-oauth:test-refresh-token" },
    });
    const subscriptionKey = await makeLlmProviderApiKey(
      setup.agent.organizationId,
      subscriptionSecret.id,
      {
        provider: "openai",
        scope: "personal",
        userId: setup.user.id,
      },
    );
    const configuredRuntime = runtime(setup.agent, "openai_responses");
    configuredRuntime.command = ["archestra-codex"];

    const { virtualApiKeyId } = await buildAgentRunLaunchSpec({
      runtime: configuredRuntime,
      taskId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      agentId: setup.agent.id,
      actor: {
        id: setup.user.id,
        kind: "user",
        organizationId: setup.agent.organizationId,
      },
      organizationId: setup.agent.organizationId,
      runtimeScope: "agent-tests",
      effectiveNetworkPolicy: { source: "built_in", policy: null },
      appName: "Archestra",
      runMode: "interactive",
    });

    const subscriptionVirtualKeys =
      await VirtualApiKeyModel.findByProviderApiKeyId(subscriptionKey.id);
    expect(subscriptionVirtualKeys.map(({ id }) => id)).toContain(
      virtualApiKeyId,
    );
  });

  test("never falls back to an OpenAI API key for Codex", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
    makeAgent,
  }) => {
    const setup = await makeConfiguredAgent({
      provider: "openai",
      makeOrganization,
      makeAdmin,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
      makeAgent,
    });
    const configuredRuntime = runtime(setup.agent, "openai_responses");
    configuredRuntime.command = ["archestra-codex"];

    await expect(
      buildAgentRunLaunchSpec({
        runtime: configuredRuntime,
        taskId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        agentId: setup.agent.id,
        actor: {
          id: setup.user.id,
          kind: "user",
          organizationId: setup.agent.organizationId,
        },
        organizationId: setup.agent.organizationId,
        runtimeScope: "agent-tests",
        effectiveNetworkPolicy: { source: "built_in", policy: null },
        appName: "Archestra",
        runMode: "interactive",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("never falls back"),
    });
  });

  test("does not inject a Claude subscription token into a custom runtime", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
    makeAgent,
  }) => {
    const setup = await makeConfiguredAgent({
      provider: "anthropic",
      makeOrganization,
      makeAdmin,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
      makeAgent,
    });
    const configuredRuntime = runtime(setup.agent, "anthropic");
    configuredRuntime.command = ["custom-agent"];
    configuredRuntime.credentials = [
      {
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        scope: "per_user",
        label: "Claude Code subscription token",
        required: false,
      },
    ];
    await UserCredentialModel.upsert({
      organizationId: setup.agent.organizationId,
      userId: setup.user.id,
      agentId: setup.agent.id,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "claude-subscription-token",
    });

    await expect(
      buildAgentRunLaunchSpec({
        runtime: configuredRuntime,
        taskId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        agentId: setup.agent.id,
        actor: {
          id: setup.user.id,
          kind: "user",
          organizationId: setup.agent.organizationId,
        },
        organizationId: setup.agent.organizationId,
        runtimeScope: "agent-tests",
        effectiveNetworkPolicy: { source: "built_in", policy: null },
        appName: "Archestra",
        runMode: "one_shot",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("only be injected"),
    });
  });
});

async function makeConfiguredAgent(params: {
  provider: SupportedProvider;
  modelId?: string;
  contextLength?: number;
  makeOrganization: () => Promise<{ id: string }>;
  makeAdmin: () => Promise<User>;
  makeMember: (
    userId: string,
    organizationId: string,
    overrides: { role: "admin" },
  ) => Promise<unknown>;
  makeSecret: (overrides: {
    secret: Record<string, unknown>;
  }) => Promise<{ id: string }>;
  makeLlmProviderApiKey: (
    organizationId: string,
    secretId: string,
    overrides: { provider: SupportedProvider },
  ) => Promise<{ id: string }>;
  makeAgent: (overrides: {
    organizationId: string;
    authorId: string;
    agentType: "agent";
    modelId: string;
    llmApiKeyId: string;
  }) => Promise<Agent>;
}): Promise<{ agent: Agent; user: User }> {
  const organization = await params.makeOrganization();
  const user = await params.makeAdmin();
  await params.makeMember(user.id, organization.id, { role: "admin" });
  const secret = await params.makeSecret({
    secret: { apiKey: "upstream-secret" },
  });
  const providerKey = await params.makeLlmProviderApiKey(
    organization.id,
    secret.id,
    { provider: params.provider },
  );
  const modelId = params.modelId ?? "selected-model";
  const model = await ModelModel.create({
    externalId: `${params.provider}/${modelId}`,
    provider: params.provider,
    modelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
    contextLength: params.contextLength,
    outputLength: 16_384,
    supportsToolCalling: true,
    lastSyncedAt: new Date(),
  });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(providerKey.id, [
    model.id,
  ]);
  const agent = await params.makeAgent({
    organizationId: organization.id,
    authorId: user.id,
    agentType: "agent",
    modelId: model.id,
    llmApiKeyId: providerKey.id,
  });
  return { agent, user };
}

function runtime(
  agent: Agent,
  inferenceProtocol: ResolvedAgentRuntime["inferenceProtocol"],
): ResolvedAgentRuntime {
  return {
    agentId: agent.id,
    organizationId: agent.organizationId,
    environmentId: null,
    secretId: null,
    image: "agent-image:dev",
    command: null,
    inferenceProtocol,
    backend: "kubernetes",
    steerMode: "pipe",
    privileged: false,
    resources: null,
    environment: null,
    credentials: null,
    ttlHours: null,
    maxCostUsd: null,
    idleTimeoutMinutes: null,
  };
}
