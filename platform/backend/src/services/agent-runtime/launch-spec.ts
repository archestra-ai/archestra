import {
  CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY,
  isDefaultBrandedAppName,
  providerDisplayNames,
  type ResourcePermissionGrant,
  RUN_ID_HEADER,
  resolveClaudeContextVariant,
  SUBSCRIPTION_CREDENTIALS,
  type SubscriptionCredentialKind,
  type SupportedProvider,
  TOOL_LIST_SKILLS_SHORT_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
} from "@archestra/shared";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { getBedrockRegion } from "@/clients/bedrock-credentials";
import { selectMCPGatewayToken } from "@/clients/chat-mcp-client";
import config from "@/config";
import {
  AgentModel,
  LimitModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  TeamTokenModel,
  VirtualApiKeyModel,
} from "@/models";
import { claudeCodeAccountManager } from "@/services/agent-runtime/claude-code-account";
import { archestraMarkWithText } from "@/services/archestra-mark";
import { isGuardrailsV2Active } from "@/services/guardrails-deployment";
import { modelSyncService } from "@/services/model-sync";
import { buildSkillDiscoveryPreview } from "@/services/skill-discovery-preview";
import type {
  AgentRunInput,
  EffectiveNetworkPolicy,
  ResolvedAgentRuntime,
} from "@/types";
import { AgentRuntimeCredentialsRequiredError, ApiError } from "@/types";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";
import type { AgentRunLaunchSpec } from "./backends";
import { resolveAgentRuntimeCredentials } from "./credentials";
import { taskWithAgentRunInputs } from "./input-files";
import {
  getClaudeCodeCloudProvider,
  preflightAgentRuntimeModelCompatibility,
} from "./model-compatibility";
import {
  AGENT_RUNTIME_STEER_FIFO,
  constructStableRunName,
} from "./runtime-contract";

/**
 * Everything a runtime backend needs to carry one A2A task, resolved for
 * the person the session acts as.
 *
 * A session needs no proxy or gateway configuration of its own: the LLM proxy
 * URL, a personal-scope virtual key (so spend attributes to the human rather
 * than a shared organization credential) and that user's MCP gateway bearer
 * are all derived from the acting identity.
 */
export async function buildAgentRunLaunchSpec(params: {
  runtime: ResolvedAgentRuntime;
  /** The A2A task this run carries; its id names the workload. */
  taskId: string;
  /** The user-facing Agent run id used by /chat/runs/:id and telemetry. */
  runId: string;
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
  runMode: "interactive" | "one_shot";
  inputFiles?: AgentRunInput[];
  imagePullSecrets?: string[];
}): Promise<{ spec: AgentRunLaunchSpec; virtualApiKeyId: string | null }> {
  const platformBaseUrl = config.agentRuntime.platformBaseUrl.replace(
    /\/+$/,
    "",
  );
  if (!platformBaseUrl) {
    // Refusing beats starting a session that would call providers directly,
    // outside every policy and cost record the proxy exists to keep.
    throw new ApiError(
      500,
      "Agent Runtime requires ARCHESTRA_AGENT_RUNTIME_PLATFORM_BASE_URL (or ARCHESTRA_INTERNAL_API_BASE_URL) so the run can reach the LLM proxy and MCP gateway",
    );
  }

  const actorUserId = params.actor.kind === "user" ? params.actor.id : null;
  const credentials = await resolveAgentRuntimeCredentials({
    runtime: params.runtime,
    organizationId: params.organizationId,
    userId: actorUserId,
  });
  if (credentials.misconfigured.length > 0) {
    throw new ApiError(
      409,
      `This Agent's Agent Runtime is missing shared credentials an administrator must configure: ${credentials.misconfigured
        .map((entry) => entry.label)
        .join(", ")}`,
    );
  }
  if (credentials.missing.length > 0) {
    throw new AgentRuntimeCredentialsRequiredError(
      params.runtime.agentId,
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
      "The Agent for this Agent Runtime run no longer exists",
    );
  }
  const skillPreview = await buildSkillDiscoveryPreview({
    agentId: params.agentId,
    organizationId: params.organizationId,
    userId: actorUserId ?? undefined,
  });
  const { llm, selectedModel, usesClaudeCodeSubscription } =
    await preflightAgentRuntimeModelCompatibility({
      runtime: params.runtime,
      agent,
      organizationId: params.organizationId,
      userId: actorUserId ?? "system",
    });

  const claudeCodeCloudProvider = getClaudeCodeCloudProvider({
    runtime: params.runtime,
    provider: llm.selectedProvider,
  });
  const isClaudeCodeBedrock = claudeCodeCloudProvider === "bedrock";
  const isClaudeCodeRuntime =
    params.runtime.command?.[0] === "archestra-claude-code";
  const isCodexRuntime = params.runtime.command?.[0] === "archestra-codex";
  if (credentials.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new ApiError(
      409,
      "A Claude Code subscription token can only be injected into the Claude Code catalog runtime.",
    );
  }
  if (usesClaudeCodeSubscription && !actorUserId) {
    throw new ApiError(
      409,
      "A personal Claude subscription requires a run acting as a signed-in user.",
    );
  }
  const claudeCodeToken =
    usesClaudeCodeSubscription && actorUserId
      ? await claudeCodeAccountManager.requireConnection({
          runtime: params.runtime,
          userId: actorUserId,
          runtimeScope: params.runtimeScope,
        })
      : undefined;
  // Claude Code supplies its own OAuth token. A personal passthrough key
  // authenticates the actor to the proxy without storing that token as a
  // provider key, so subscription requests retain usage and run attribution.
  const virtualKey = usesClaudeCodeSubscription
    ? await VirtualApiKeyModel.create({
        organizationId: params.organizationId,
        name: `agent-run-${params.taskId.slice(0, 8)}`,
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
  const virtualKeyValue = virtualKey?.value ?? "";
  if (params.runtime.maxCostUsd && virtualKey) {
    try {
      await LimitModel.create({
        entityType: "virtual_key",
        entityId: virtualKey.virtualKey.id,
        limitType: "token_cost",
        limitValue: params.runtime.maxCostUsd,
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
  const bedrockUrl = `${platformBaseUrl}/v1/bedrock/${params.agentId}`;
  const proxyUrl = isClaudeCodeBedrock
    ? bedrockUrl
    : params.runtime.inferenceProtocol === "anthropic"
      ? anthropicUrl
      : modelRouterUrl;
  const runtimeModel =
    params.runtime.inferenceProtocol !== "anthropic"
      ? `${llm.selectedProvider}:${llm.selectedModel}`
      : llm.selectedModel;
  const nativeModel =
    isClaudeCodeRuntime && !claudeCodeCloudProvider
      ? resolveClaudeContextVariant({
          modelId: llm.selectedModel,
          contextLength: selectedModel
            ? ModelModel.resolveArchitecturalContextLength(selectedModel)
            : null,
        })
      : llm.selectedModel;
  const modelContextLength = selectedModel
    ? ModelModel.resolveEffectiveContextLength(selectedModel)
    : null;
  const modelOutputLength = selectedModel
    ? ModelModel.resolveEffectiveOutputLength(selectedModel)
    : null;
  const nonSecretEnv: Record<string, string> = {
    // The Agent Runtime run's own environment goes first: the addresses below must win.
    // An entry overriding ANTHROPIC_BASE_URL would be exactly the bypass the
    // platform-URL guard above exists to prevent.
    ...Object.fromEntries(
      (params.runtime.environment ?? [])
        .filter(({ key }) => !RESERVED_RUNTIME_ENV_KEYS.has(key))
        .map(({ key, value }) => [key, value]),
    ),
    ARCHESTRA_AGENT_RUNTIME_AGENT_ID: params.runtime.agentId,
    ARCHESTRA_AGENT_RUNTIME_AGENT_NAME: agent.name,
    ARCHESTRA_AGENT_RUNTIME_RUN_ID: params.runId,
    ARCHESTRA_AGENT_RUNTIME_TASK_ID: params.taskId,
    ARCHESTRA_AGENT_RUNTIME_MODEL: runtimeModel,
    // Native CLIs use provider-published model slugs for local metadata and
    // capability detection. Their single-provider virtual key keeps this
    // unambiguous at the Model Router while the generic Agent Runtime client retains the
    // qualified model id above.
    ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL: nativeModel,
    ARCHESTRA_AGENT_RUNTIME_MODEL_PROVIDER: llm.selectedProvider,
    ...(modelContextLength
      ? {
          ARCHESTRA_AGENT_RUNTIME_MODEL_CONTEXT_LENGTH:
            String(modelContextLength),
        }
      : {}),
    ...(modelOutputLength
      ? {
          ARCHESTRA_AGENT_RUNTIME_MODEL_OUTPUT_LENGTH:
            String(modelOutputLength),
        }
      : {}),
    ARCHESTRA_AGENT_RUNTIME_MODE: params.runMode,
    ARCHESTRA_AGENT_RUNTIME_BANNER: runBanner(params.appName),
    ARCHESTRA_AGENT_RUNTIME_STEER_FIFO: AGENT_RUNTIME_STEER_FIFO,
    // The finish contract: a session that has done its work parks this long
    // for further direction, then exits so the run and task settle.
    ARCHESTRA_AGENT_RUNTIME_IDLE_TIMEOUT_SECONDS: String(
      (params.runtime.idleTimeoutMinutes ??
        config.agentRuntime.defaultIdleTimeoutMinutes) * 60,
    ),
    ARCHESTRA_LLM_PROXY_URL: proxyUrl,
    ARCHESTRA_LLM_PROXY_PROTOCOL: params.runtime.inferenceProtocol,
    // Clients that hide tools from the wire (Codex's tool search and code
    // mode) must declare them inline for OpenAPPA to govern the session. A
    // continuation relaunches the client, so it re-reads the switch.
    ...((await isGuardrailsV2Active())
      ? { ARCHESTRA_AGENT_RUNTIME_OPENAPPA: "1" }
      : {}),
    ...(usesClaudeCodeSubscription
      ? { ARCHESTRA_AGENT_RUNTIME_CLAUDE_AUTH: "subscription" }
      : { OPENAI_BASE_URL: modelRouterUrl }),
    ANTHROPIC_BASE_URL: anthropicUrl,
    ...(isClaudeCodeBedrock
      ? {
          CLAUDE_CODE_USE_BEDROCK: "1",
          ANTHROPIC_BEDROCK_BASE_URL: bedrockUrl,
          AWS_REGION: getBedrockRegion(),
        }
      : {}),
    ARCHESTRA_MCP_GATEWAY_URL: `${platformBaseUrl}/v1/mcp/${params.agentId}`,
  };

  const task = taskWithAgentRunInputs({
    task: params.task,
    inputs: params.inputFiles ?? [],
  });
  const secretEnv: Record<string, string> = {
    ARCHESTRA_MCP_GATEWAY_TOKEN: gatewayToken,
    ...(claudeCodeToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeCodeToken } : {}),
    ...(virtualKey ? { ARCHESTRA_VIRTUAL_KEY: virtualKeyValue } : {}),
    ...(!isClaudeCodeBedrock && !usesClaudeCodeSubscription
      ? {
          // Maintained and bring-your-own CLIs read the provider variables,
          // so the standard virtual key is presented in each native shape.
          // The upstream provider secret stays server-side.
          ANTHROPIC_API_KEY: virtualKeyValue,
          ANTHROPIC_AUTH_TOKEN: virtualKeyValue,
          OPENAI_API_KEY: virtualKeyValue,
        }
      : {}),
    ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT: [
      agent.systemPrompt,
      skillPreview,
      "Skills configured for this Agent are available through its MCP gateway, " +
        "not necessarily in this client's native skill directories. " +
        `Use ${archestraMcpBranding.getToolName(TOOL_LIST_SKILLS_SHORT_NAME)} ` +
        "to discover available skills and " +
        `${archestraMcpBranding.getToolName(TOOL_LOAD_SKILL_SHORT_NAME)} ` +
        "to load matching instructions and bundled resources. " +
        "If these tools are not directly listed, discover them through the gateway's tool search. " +
        "Save bundled resources with their relative paths before running them locally; " +
        "decode resources marked base64 with a shell decoder, not a text-file tool. " +
        "Paths advertised as code-sandbox mounts belong to that separate sandbox, " +
        "not this runtime's filesystem.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    ...(task ? { ARCHESTRA_AGENT_RUNTIME_TASK: task } : {}),
    ...withNativeClientCredentialAliases(credentials.env),
    ...(isClaudeCodeBedrock
      ? { AWS_BEARER_TOKEN_BEDROCK: virtualKeyValue }
      : {}),
    ...(isClaudeCodeRuntime
      ? {
          // Claude Code accepts only one custom-header variable. Subscription
          // requests need the passthrough key as well as run correlation.
          [CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY]: claudeCodeCustomHeaders({
            taskId: params.taskId,
            passthroughKey: usesClaudeCodeSubscription
              ? virtualKeyValue
              : undefined,
          }),
        }
      : {}),
  };

  return {
    virtualApiKeyId: virtualKey?.virtualKey.id ?? null,
    spec: {
      poolScope: `${params.organizationId}:${params.runtime.environmentId ?? "default"}`,
      taskId: params.taskId,
      agentRuntimeId: params.runtime.agentId,
      frozenName: constructStableRunName(agent.name, params.taskId),
      runtimeScope: params.runtimeScope,
      image: params.runtime.image,
      command: params.runtime.command ?? null,
      privileged: params.runtime.privileged,
      resources: params.runtime.resources ?? {
        cpuRequest: config.agentRuntime.resources.cpuRequest,
        memoryRequest: config.agentRuntime.resources.memoryRequest,
        memoryLimit: config.agentRuntime.resources.memoryLimit,
      },
      env: nonSecretEnv,
      secretEnv,
      ...(Object.keys(credentials.renewableCredentials).length
        ? { renewableCredentials: credentials.renewableCredentials }
        : {}),
      activeDeadlineSeconds:
        (params.runtime.ttlHours ?? config.agentRuntime.defaultTtlHours) *
        60 *
        60,
      workspaceStorageSize: config.agentRuntime.workspaceStorageSize,
      workspaceStorageClass: config.agentRuntime.workspaceStorageClass,
      nodeSelector: config.agentRuntime.nodeSelector,
      imagePullSecrets: params.imagePullSecrets ?? [],
      effectiveNetworkPolicy: params.effectiveNetworkPolicy,
      inputFileCount: params.inputFiles?.length ?? 0,
    },
  };
}

function runBanner(appName: string): string {
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
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "ARCHESTRA_AGENT_RUNTIME_CLAUDE_AUTH",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ARCHESTRA_AGENT_RUNTIME_AGENT_ID",
  "ARCHESTRA_AGENT_RUNTIME_AGENT_NAME",
  "ARCHESTRA_AGENT_RUNTIME_BANNER",
  "ARCHESTRA_AGENT_RUNTIME_MODE",
  "ARCHESTRA_AGENT_RUNTIME_MODEL",
  "ARCHESTRA_AGENT_RUNTIME_MODEL_CONTEXT_LENGTH",
  "ARCHESTRA_AGENT_RUNTIME_MODEL_OUTPUT_LENGTH",
  "ARCHESTRA_AGENT_RUNTIME_MODEL_PROVIDER",
  "ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL",
  "ARCHESTRA_AGENT_RUNTIME_OPENAPPA",
  "ARCHESTRA_AGENT_RUNTIME_RUN_ID",
  "ARCHESTRA_AGENT_RUNTIME_STEER_FIFO",
  "ARCHESTRA_AGENT_RUNTIME_TASK_ID",
  "ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT",
  "ARCHESTRA_LLM_PROXY_PROTOCOL",
  "ARCHESTRA_LLM_PROXY_URL",
  "ARCHESTRA_MCP_GATEWAY_TOKEN",
  "ARCHESTRA_MCP_GATEWAY_URL",
  "ARCHESTRA_VIRTUAL_KEY",
]);

function claudeCodeCustomHeaders(params: {
  taskId: string;
  passthroughKey?: string;
}): string {
  return [
    // The image adds the session headers: they name the workspace, which
    // pod-run assigns after this spec is built.
    `${RUN_ID_HEADER}: ${params.taskId}`,
    ...(params.passthroughKey
      ? [`X-Archestra-Virtual-Key: ${params.passthroughKey}`]
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
      `Connect your own ${resolvedProviderCredential.authRequired.providerLabel} before starting this Agent's Agent Runtime. Subscription credentials are never shared between users.`,
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
      `No ${providerDisplayNames[params.provider]} credential is available for this Agent and user, so the Agent Runtime run cannot use its selected model.`,
    );
  }

  if (requiredSubscription && params.requiredSubscriptionKind) {
    // The runtime uses the actor's subscription, which may have been synced
    // before the selected model was released (or before another user's key).
    // Refresh that connection rather than bypassing the router's model links.
    const hasSelectedModel = async () => {
      const models = await LlmProviderApiKeyModelLinkModel.getModelsForApiKey(
        providerApiKey.id,
      );
      return models.some(
        (model) =>
          model.provider === params.provider &&
          model.modelId === params.model &&
          ModelModel.supportsTextChat(model),
      );
    };
    if (!(await hasSelectedModel())) {
      await modelSyncService.syncModelsForApiKey({
        apiKeyId: providerApiKey.id,
        provider: providerApiKey.provider,
        apiKeyValue: requiredSubscription.apiKeyValue,
      });
      if (!(await hasSelectedModel())) {
        throw new ApiError(
          409,
          `The selected model "${params.model}" is not available through your ${SUBSCRIPTION_CREDENTIALS[params.requiredSubscriptionKind].label}. Choose a model supported by that connection.`,
        );
      }
    }
  }

  return VirtualApiKeyModel.create({
    organizationId: params.organizationId,
    name: `agent-run-${params.taskId.slice(0, 8)}`,
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
    "Could not resolve an MCP gateway token for this run actor",
  );
}

/**
 * Who the run's virtual key reaches, as creation grants. A user actor's key
 * is the user's own (the author gets full access from creation, and nothing
 * else reaches it), which is what attributes the session's LLM spend to that
 * person. A team actor's key reaches the team; an organization actor's key is
 * published to the organization. The retired `scope` column is written to
 * match, though nothing reads it.
 */
function virtualKeyVisibility(actor: A2AActor): {
  scope: "personal" | "team" | "org";
  authorId: string | null;
  initialPermissionGrants?: ResourcePermissionGrant[];
  publishToOrganization?: boolean;
} {
  if (actor.kind === "user") {
    return { scope: "personal", authorId: actor.id };
  }
  if (actor.kind === "team") {
    return {
      scope: "team",
      authorId: null,
      initialPermissionGrants: [
        { subject: { type: "team", id: actor.id }, actions: ["read", "use"] },
      ],
    };
  }
  return { scope: "org", authorId: null, publishToOrganization: true };
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
