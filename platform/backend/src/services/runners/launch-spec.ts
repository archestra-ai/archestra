import {
  CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY,
  EXECUTION_ID_HEADER,
  isDefaultBrandedAppName,
  MODEL_ROUTER_SUPPORTED_PROVIDERS,
  providerDisplayNames,
  requiresOpenAiResponsesApi,
  requiresResponsesApi,
  SESSION_ID_HEADER,
  SUBSCRIPTION_CREDENTIALS,
  type SubscriptionCredentialKind,
  type SupportedProvider,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import { selectMCPGatewayToken } from "@/clients/chat-mcp-client";
import config from "@/config";
import {
  AgentModel,
  LimitModel,
  LlmProviderApiKeyModel,
  ModelModel,
  TeamTokenModel,
  VirtualApiKeyModel,
} from "@/models";
import { archestraMarkWithText } from "@/services/archestra-mark";
import type {
  AgentDeployment,
  AgentExecutionInput,
  EffectiveNetworkPolicy,
  MissingAgentDeploymentCredential,
} from "@/types";
import { AGENT_DEPLOYMENT_CREDENTIALS_REQUIRED_CODE, ApiError } from "@/types";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";
import { resolveConversationLlmSelectionForAgent } from "@/utils/llm-resolution";
import type { RunnerLaunchSpec } from "./backends";
import { resolveAgentDeploymentCredentials } from "./credentials";
import { taskWithAgentExecutionInputs } from "./input-files";
import {
  constructStableExecutionName,
  RUNNER_STEER_FIFO,
} from "./runtime-contract";

/**
 * Raised when a session cannot start only because the person it would act as
 * has not supplied credentials the Agent declares. Carries the list so every
 * surface can name exactly what to add instead of reporting an opaque failure.
 */
class AgentDeploymentCredentialsRequiredError extends ApiError {
  readonly code = AGENT_DEPLOYMENT_CREDENTIALS_REQUIRED_CODE;
  readonly agentId: string;
  readonly missing: MissingAgentDeploymentCredential[];

  constructor(agentId: string, missing: MissingAgentDeploymentCredential[]) {
    super(
      409,
      `This Agent's background execution needs credentials you have not set up yet: ${missing
        .map((entry) => entry.label)
        .join(", ")}`,
    );
    this.name = "AgentDeploymentCredentialsRequiredError";
    this.agentId = agentId;
    this.missing = missing;
  }
}

/**
 * Everything an execution backend needs to carry one A2A task, resolved for
 * the person the session acts as.
 *
 * A session needs no proxy or gateway configuration of its own: the LLM proxy
 * URL, a personal-scope virtual key (so spend attributes to the human rather
 * than a shared organization credential) and that user's MCP gateway bearer
 * are all derived from the acting identity.
 */
export async function buildRunnerLaunchSpec(params: {
  deployment: AgentDeployment;
  /** The A2A task this execution carries; its id names the workload. */
  taskId: string;
  /** Agent the task belongs to, for the proxy and gateway routes. */
  agentId: string;
  actor: A2AActor;
  organizationId: string;
  runtimeScope: string;
  effectiveNetworkPolicy: EffectiveNetworkPolicy;
  /** White-label product name rendered by the built-in terminal UI. */
  appName: string;
  /** The first instruction, when the task started with one. */
  task?: string | null;
  /** Whether the Agent owns a live TUI or exits after its first result. */
  executionMode: "interactive" | "one_shot";
  inputFiles?: AgentExecutionInput[];
  imagePullSecrets?: string[];
}): Promise<{ spec: RunnerLaunchSpec; virtualApiKeyId: string }> {
  const platformBaseUrl =
    config.agentBackgroundExecution.platformBaseUrl.replace(/\/+$/, "");
  if (!platformBaseUrl) {
    // Refusing beats starting a session that would call providers directly,
    // outside every policy and cost record the proxy exists to keep.
    throw new ApiError(
      500,
      "Background execution requires ARCHESTRA_AGENT_BACKGROUND_EXECUTION_PLATFORM_BASE_URL (or ARCHESTRA_INTERNAL_API_BASE_URL) so the run can reach the LLM proxy and MCP gateway",
    );
  }

  const actorUserId = params.actor.kind === "user" ? params.actor.id : null;
  const credentials = await resolveAgentDeploymentCredentials({
    deployment: params.deployment,
    organizationId: params.organizationId,
    userId: actorUserId,
  });
  if (credentials.misconfigured.length > 0) {
    throw new ApiError(
      409,
      `This Agent's background execution is missing shared credentials an administrator must configure: ${credentials.misconfigured
        .map((entry) => entry.label)
        .join(", ")}`,
    );
  }
  if (credentials.missing.length > 0) {
    throw new AgentDeploymentCredentialsRequiredError(
      params.deployment.agentId,
      credentials.missing,
    );
  }

  const gatewayToken = await resolveGatewayToken({
    actor: params.actor,
    agentId: params.agentId,
    organizationId: params.organizationId,
  });

  const agent = await AgentModel.findById(params.agentId);
  if (!agent) {
    throw new ApiError(
      404,
      "The Agent for this background run no longer exists",
    );
  }
  const llm = await resolveConversationLlmSelectionForAgent({
    agent,
    organizationId: params.organizationId,
    userId: actorUserId ?? "system",
    includeMemberChatDefault: false,
  });
  assertInferenceProtocolSupported({
    protocol: params.deployment.inferenceProtocol,
    provider: llm.selectedProvider,
    model: llm.selectedModel,
    supportedEndpoints: llm.modelId
      ? (await ModelModel.findById(llm.modelId))?.supportedEndpoints
      : null,
  });

  const claudeCodeSubscriptionToken =
    credentials.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const usesClaudeCodeSubscription = Boolean(claudeCodeSubscriptionToken);
  const isClaudeCodeRuntime =
    params.deployment.command?.[0] === "archestra-claude-code";
  const isCodexRuntime = params.deployment.command?.[0] === "archestra-codex";
  if (isClaudeCodeRuntime && !usesClaudeCodeSubscription) {
    throw new ApiError(
      409,
      "Connect your Claude Code subscription before starting this Agent. The maintained Claude Code runtime never falls back to usage-based API billing.",
    );
  }
  if (usesClaudeCodeSubscription && !isClaudeCodeRuntime) {
    throw new ApiError(
      409,
      "A Claude Code subscription token can only be injected into the Claude Code catalog runtime.",
    );
  }
  if (isCodexRuntime && llm.selectedProvider !== "openai") {
    throw new ApiError(
      409,
      "The maintained Codex runtime requires an OpenAI model from your ChatGPT subscription.",
    );
  }

  // Most runtimes receive a standard virtual key mapped to the provider/model
  // selected on the Agent. The resolver substitutes the acting user's own
  // matching subscription (for example ChatGPT/Codex) when the selected key
  // belongs to somebody else, so connecting once covers chat and execution.
  //
  // Claude Code subscriptions are intentionally narrower. The official CLI
  // keeps its own OAuth token and sends it through the Anthropic proxy; a
  // passthrough virtual key in a separate header authenticates and attributes
  // that request without turning the OAuth token into a generic provider key.
  const virtualKey = usesClaudeCodeSubscription
    ? await VirtualApiKeyModel.create({
        organizationId: params.organizationId,
        name: `background-task-${params.taskId.slice(0, 8)}`,
        keyType: "passthrough",
        ...virtualKeyVisibility(params.actor),
      })
    : await createProviderBackedVirtualKey({
        organizationId: params.organizationId,
        actor: params.actor,
        taskId: params.taskId,
        provider: llm.selectedProvider,
        model: llm.selectedModel,
        agentLlmApiKeyId: agent.llmApiKeyId,
        requiredSubscriptionKind: isCodexRuntime ? "chatgpt" : null,
      });
  if (params.deployment.maxCostUsd) {
    try {
      await LimitModel.create({
        entityType: "virtual_key",
        entityId: virtualKey.virtualKey.id,
        limitType: "token_cost",
        limitValue: params.deployment.maxCostUsd,
        model: null,
        cleanupInterval: "1m",
      });
    } catch (error) {
      await VirtualApiKeyModel.delete(virtualKey.virtualKey.id);
      throw error;
    }
  }

  const modelRouterUrl = `${platformBaseUrl}/v1/model-router/${params.agentId}`;
  const anthropicUrl = `${platformBaseUrl}/v1/anthropic/${params.agentId}`;
  const proxyUrl =
    params.deployment.inferenceProtocol === "anthropic"
      ? anthropicUrl
      : modelRouterUrl;
  const runtimeModel =
    params.deployment.inferenceProtocol !== "anthropic"
      ? `${llm.selectedProvider}:${llm.selectedModel}`
      : llm.selectedModel;
  const nonSecretEnv: Record<string, string> = {
    // The runner's own environment goes first: the addresses below must win.
    // An entry overriding ANTHROPIC_BASE_URL would be exactly the bypass the
    // platform-URL guard above exists to prevent.
    ...Object.fromEntries(
      (params.deployment.environment ?? [])
        .filter(({ key }) => !RESERVED_RUNTIME_ENV_KEYS.has(key))
        .map(({ key, value }) => [key, value]),
    ),
    ARCHESTRA_AGENT_BACKGROUND_EXECUTION_AGENT_ID: params.deployment.agentId,
    ARCHESTRA_AGENT_BACKGROUND_EXECUTION_AGENT_NAME: agent.name,
    ARCHESTRA_AGENT_BACKGROUND_EXECUTION_TASK_ID: params.taskId,
    ARCHESTRA_AGENT_BACKGROUND_EXECUTION_MODEL: runtimeModel,
    // Native CLIs use provider-published model slugs for local metadata and
    // capability detection. Their single-provider virtual key keeps this
    // unambiguous at the Model Router while the generic runner retains the
    // qualified model id above.
    ARCHESTRA_AGENT_BACKGROUND_EXECUTION_NATIVE_MODEL: llm.selectedModel,
    ARCHESTRA_AGENT_BACKGROUND_EXECUTION_MODEL_PROVIDER: llm.selectedProvider,
    ARCHESTRA_AGENT_BACKGROUND_EXECUTION_MODE: params.executionMode,
    ARCHESTRA_AGENT_BACKGROUND_EXECUTION_BANNER: executionBanner(
      params.appName,
    ),
    ARCHESTRA_AGENT_BACKGROUND_EXECUTION_STEER_FIFO: RUNNER_STEER_FIFO,
    // The finish contract: a session that has done its work parks this long
    // for further direction, then exits so the execution and task settle.
    ARCHESTRA_AGENT_BACKGROUND_EXECUTION_IDLE_TIMEOUT_SECONDS: String(
      (params.deployment.idleTimeoutMinutes ??
        config.agentBackgroundExecution.defaultIdleTimeoutMinutes) * 60,
    ),
    ARCHESTRA_LLM_PROXY_URL: proxyUrl,
    ARCHESTRA_LLM_PROXY_PROTOCOL: params.deployment.inferenceProtocol,
    OPENAI_BASE_URL: modelRouterUrl,
    ANTHROPIC_BASE_URL: anthropicUrl,
    ARCHESTRA_MCP_GATEWAY_URL: `${platformBaseUrl}/v1/mcp/${params.agentId}`,
  };

  const task = taskWithAgentExecutionInputs({
    task: params.task,
    inputs: params.inputFiles ?? [],
  });
  const secretEnv: Record<string, string> = {
    ARCHESTRA_MCP_GATEWAY_TOKEN: gatewayToken,
    ARCHESTRA_VIRTUAL_KEY: virtualKey.value,
    ...(!usesClaudeCodeSubscription
      ? {
          // Both the Archestra runner-agent and bring-your-own CLIs read the
          // provider variables, so the standard virtual key is presented in
          // each native shape. The upstream provider secret stays server-side.
          ANTHROPIC_API_KEY: virtualKey.value,
          ANTHROPIC_AUTH_TOKEN: virtualKey.value,
          OPENAI_API_KEY: virtualKey.value,
        }
      : {}),
    ...(agent.systemPrompt
      ? {
          ARCHESTRA_AGENT_BACKGROUND_EXECUTION_SYSTEM_PROMPT:
            agent.systemPrompt,
        }
      : {}),
    ...(task ? { ARCHESTRA_AGENT_BACKGROUND_EXECUTION_TASK: task } : {}),
    ...withNativeClientCredentialAliases(credentials.env),
    ...(params.deployment.command?.[0] === "archestra-claude-code"
      ? {
          // Claude Code accepts only one custom-header variable. Keep run
          // correlation on both auth paths, and add the passthrough identity
          // only when the CLI supplies its own subscription credential.
          [CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY]: claudeCodeCustomHeaders({
            taskId: params.taskId,
            passthroughVirtualKey: usesClaudeCodeSubscription
              ? virtualKey.value
              : null,
          }),
        }
      : {}),
  };

  return {
    virtualApiKeyId: virtualKey.virtualKey.id,
    spec: {
      taskId: params.taskId,
      runnerId: params.deployment.agentId,
      frozenName: constructStableExecutionName(agent.name, params.taskId),
      runtimeScope: params.runtimeScope,
      image: params.deployment.image,
      command: params.deployment.command ?? null,
      privileged: params.deployment.privileged,
      resources: params.deployment.resources ?? {
        cpuRequest: config.agentBackgroundExecution.resources.cpuRequest,
        memoryRequest: config.agentBackgroundExecution.resources.memoryRequest,
        memoryLimit: config.agentBackgroundExecution.resources.memoryLimit,
      },
      env: nonSecretEnv,
      secretEnv,
      activeDeadlineSeconds:
        (params.deployment.ttlHours ??
          config.agentBackgroundExecution.defaultTtlHours) *
        60 *
        60,
      ephemeralStorageLimit:
        config.agentBackgroundExecution.ephemeralStorageLimit,
      imagePullSecrets: params.imagePullSecrets ?? [],
      effectiveNetworkPolicy: params.effectiveNetworkPolicy,
      inputFileCount: params.inputFiles?.length ?? 0,
    },
  };
}

function executionBanner(appName: string): string {
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  if (config.enterpriseFeatures.fullWhiteLabeling) {
    return `${appName}\nSecure access to your AI tools`;
  }
  // SPDX-SnippetEnd

  return isDefaultBrandedAppName(appName)
    ? archestraMarkWithText({ appName }).join("\n")
    : `${appName}\nSecure access to your AI tools`;
}

const RESERVED_RUNTIME_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ARCHESTRA_AGENT_BACKGROUND_EXECUTION_AGENT_ID",
  "ARCHESTRA_AGENT_BACKGROUND_EXECUTION_AGENT_NAME",
  "ARCHESTRA_AGENT_BACKGROUND_EXECUTION_BANNER",
  "ARCHESTRA_AGENT_BACKGROUND_EXECUTION_MODE",
  "ARCHESTRA_AGENT_BACKGROUND_EXECUTION_MODEL",
  "ARCHESTRA_AGENT_BACKGROUND_EXECUTION_MODEL_PROVIDER",
  "ARCHESTRA_AGENT_BACKGROUND_EXECUTION_NATIVE_MODEL",
  "ARCHESTRA_AGENT_BACKGROUND_EXECUTION_STEER_FIFO",
  "ARCHESTRA_AGENT_BACKGROUND_EXECUTION_TASK_ID",
  "ARCHESTRA_LLM_PROXY_PROTOCOL",
  "ARCHESTRA_LLM_PROXY_URL",
  "ARCHESTRA_MCP_GATEWAY_TOKEN",
  "ARCHESTRA_MCP_GATEWAY_URL",
  "ARCHESTRA_VIRTUAL_KEY",
]);

function claudeCodeCustomHeaders(params: {
  taskId: string;
  passthroughVirtualKey: string | null;
}): string {
  return [
    `${EXECUTION_ID_HEADER}: ${params.taskId}`,
    `${SESSION_ID_HEADER}: ${params.taskId}`,
    ...(params.passthroughVirtualKey
      ? [`${VIRTUAL_KEY_HEADER}: ${params.passthroughVirtualKey}`]
      : []),
  ].join("\n");
}

async function createProviderBackedVirtualKey(params: {
  organizationId: string;
  actor: A2AActor;
  taskId: string;
  provider: SupportedProvider;
  model: string;
  agentLlmApiKeyId: string | null;
  requiredSubscriptionKind: SubscriptionCredentialKind | null;
}): Promise<Awaited<ReturnType<typeof VirtualApiKeyModel.create>>> {
  const actorUserId = params.actor.kind === "user" ? params.actor.id : null;
  const requiredSubscription =
    params.requiredSubscriptionKind && actorUserId
      ? await LlmProviderApiKeyModel.findPersonalSubscriptionKey({
          organizationId: params.organizationId,
          userId: actorUserId,
          kind: params.requiredSubscriptionKind,
        })
      : null;
  if (params.requiredSubscriptionKind && !requiredSubscription) {
    throw new ApiError(
      409,
      `Connect your own ${SUBSCRIPTION_CREDENTIALS[params.requiredSubscriptionKind].label} before starting this Agent. The maintained runtime never falls back to usage-based API billing.`,
    );
  }
  const resolvedProviderCredential = requiredSubscription
    ? {
        authRequired: undefined,
        chatApiKeyId: requiredSubscription.apiKey.id,
      }
    : await resolveProviderApiKey({
        organizationId: params.organizationId,
        userId: actorUserId ?? undefined,
        provider: params.provider,
        agentLlmApiKeyId: params.agentLlmApiKeyId ?? undefined,
        modelName: params.model,
      });
  if (resolvedProviderCredential.authRequired) {
    throw new ApiError(
      409,
      `Connect your own ${resolvedProviderCredential.authRequired.providerLabel} before starting this Agent's background execution. Subscription credentials are never shared between users.`,
    );
  }
  const providerApiKey = resolvedProviderCredential.chatApiKeyId
    ? await LlmProviderApiKeyModel.findById(
        resolvedProviderCredential.chatApiKeyId,
      )
    : null;
  if (!providerApiKey) {
    throw new ApiError(
      409,
      `No ${providerDisplayNames[params.provider]} credential is available for this Agent and user, so the background run cannot use its selected model.`,
    );
  }

  return VirtualApiKeyModel.create({
    organizationId: params.organizationId,
    name: `background-task-${params.taskId.slice(0, 8)}`,
    // Personal scope is what attributes the session's LLM spend to the human
    // it acts as rather than to the organization at large.
    ...virtualKeyVisibility(params.actor),
    providerApiKeys: [
      {
        provider: params.provider,
        providerApiKeyId: providerApiKey.id,
      },
    ],
  });
}

async function resolveGatewayToken(params: {
  actor: A2AActor;
  agentId: string;
  organizationId: string;
}): Promise<string> {
  if (params.actor.kind === "team") {
    const token = await TeamTokenModel.findTeamToken(params.actor.id);
    const value = token ? await TeamTokenModel.getTokenValue(token.id) : null;
    if (value) return value;
  } else {
    const selected = await selectMCPGatewayToken(
      params.agentId,
      params.actor.kind === "user" ? params.actor.id : "system",
      params.organizationId,
    );
    if (selected?.tokenValue) return selected.tokenValue;
  }
  throw new ApiError(
    500,
    "Could not resolve an MCP gateway token for this execution actor",
  );
}

function virtualKeyVisibility(actor: A2AActor): {
  scope: "personal" | "team" | "org";
  authorId: string | null;
  teamIds?: string[];
} {
  if (actor.kind === "user") {
    return { scope: "personal", authorId: actor.id };
  }
  if (actor.kind === "team") {
    return { scope: "team", authorId: null, teamIds: [actor.id] };
  }
  return { scope: "org", authorId: null };
}

function withNativeClientCredentialAliases(
  credentials: Record<string, string>,
): Record<string, string> {
  // GitHub accepts GITHUB_TOKEN across its APIs, while the gh CLI's canonical
  // non-interactive variable is GH_TOKEN. Catalog users declare it once and
  // git/gh-based clients receive the shape they expect.
  return credentials.GITHUB_TOKEN && !credentials.GH_TOKEN
    ? { ...credentials, GH_TOKEN: credentials.GITHUB_TOKEN }
    : credentials;
}

function assertInferenceProtocolSupported(params: {
  protocol: AgentDeployment["inferenceProtocol"];
  provider: SupportedProvider;
  model: string;
  supportedEndpoints: string[] | null | undefined;
}): void {
  if (params.protocol === "anthropic" && params.provider !== "anthropic") {
    throw new ApiError(
      409,
      `This background image expects the Anthropic API, but the Agent's selected model uses ${providerDisplayNames[params.provider]}. Choose an Anthropic model or use an OpenAI-compatible background image.`,
    );
  }
  if (
    params.protocol !== "anthropic" &&
    !new Set<SupportedProvider>(MODEL_ROUTER_SUPPORTED_PROVIDERS).has(
      params.provider,
    )
  ) {
    throw new ApiError(
      409,
      `${providerDisplayNames[params.provider]} models are not available through the OpenAI-compatible model router used by this background image.`,
    );
  }
  if (
    params.protocol === "openai_chat" &&
    (requiresResponsesApi(params.supportedEndpoints) ||
      (params.provider === "openai" &&
        requiresOpenAiResponsesApi(params.model)))
  ) {
    throw new ApiError(
      409,
      `This background image uses Chat Completions, but model "${params.model}" requires the Responses API. Choose a Chat Completions model or an image that uses OpenAI Responses.`,
    );
  }
}
