import {
  isCodexRuntimeCommand,
  isCredentialLevelSubscriptionProvider,
  providerDisplayNames,
  providerRequiresPerUserCredential,
  SUBSCRIPTION_CREDENTIALS,
  type SubscriptionCredentialKind,
  type SupportedProvider,
  subscriptionKindFromCredential,
  TimeInMs,
} from "@archestra/shared";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import { serviceAccountUserId } from "@/auth/service-account-user-id";
import logger from "@/logging";
import {
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
} from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { modelSyncService } from "@/services/model-sync";
import type { Agent, ResolvedAgentRuntime } from "@/types";
import { AgentRuntimeCredentialsRequiredError, ApiError } from "@/types";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";
import { prepareAgentRuntimeBackendDriver } from "./backends";
import { claudeCodeAccountManager } from "./claude-code-account";
import { preflightAgentRuntimeCredentials } from "./credentials";
import { preflightAgentRuntimeModelCompatibility } from "./model-compatibility";

const LAZY_SUBSCRIPTION_SYNC_COOLDOWN_MS = 5 * TimeInMs.Minute;

const lazySubscriptionSyncCache = new Map<
  string,
  {
    subscriptionKind: SubscriptionCredentialKind | null;
    expiresAt: number;
  }
>();

export async function ensureProviderApiKeySupportsSelectedModel(params: {
  providerApiKey: {
    id: string;
    provider: SupportedProvider;
    secretId: string | null;
  };
  provider: SupportedProvider;
  model: string;
  subscriptionCredential?: {
    kind: SubscriptionCredentialKind;
    apiKeyValue: string;
  } | null;
}): Promise<void> {
  const { providerApiKey, provider, model } = params;
  const hasSelectedModel = async () => {
    const models = await LlmProviderApiKeyModelLinkModel.getModelsForApiKey(
      providerApiKey.id,
    );
    return models.some(
      (linked) =>
        linked.provider === provider &&
        linked.modelId === model &&
        ModelModel.supportsTextChat(linked),
    );
  };

  if (await hasSelectedModel()) {
    return;
  }

  const now = Date.now();
  const cacheKey = `${providerApiKey.id}:${providerApiKey.secretId ?? ""}`;
  const cached = lazySubscriptionSyncCache.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    if (cached.subscriptionKind) {
      throw new ApiError(
        409,
        `The selected model "${model}" is not available through your ${SUBSCRIPTION_CREDENTIALS[cached.subscriptionKind].label}. Choose a model supported by that connection.`,
      );
    }
    return;
  }

  let subscriptionKind = params.subscriptionCredential?.kind ?? null;
  let apiKeyValue = params.subscriptionCredential?.apiKeyValue;
  let secretReadFailed = false;

  if (
    !subscriptionKind &&
    isCredentialLevelSubscriptionProvider(providerApiKey.provider) &&
    providerApiKey.secretId
  ) {
    try {
      apiKeyValue = await getSecretValueForLlmProviderApiKey(
        providerApiKey.secretId,
      );
      subscriptionKind = apiKeyValue
        ? subscriptionKindFromCredential(apiKeyValue)
        : null;
    } catch {
      subscriptionKind = null;
      secretReadFailed = true;
    }
  }

  if (!subscriptionKind || !apiKeyValue) {
    if (!secretReadFailed) {
      lazySubscriptionSyncCache.set(cacheKey, {
        subscriptionKind: null,
        expiresAt: now + LAZY_SUBSCRIPTION_SYNC_COOLDOWN_MS,
      });
    }
    return;
  }

  await modelSyncService.syncModelsForApiKey({
    apiKeyId: providerApiKey.id,
    provider: providerApiKey.provider,
    apiKeyValue,
  });
  lazySubscriptionSyncCache.set(cacheKey, {
    subscriptionKind,
    expiresAt: Date.now() + LAZY_SUBSCRIPTION_SYNC_COOLDOWN_MS,
  });

  if (!(await hasSelectedModel())) {
    throw new ApiError(
      409,
      `The selected model "${model}" is not available through your ${SUBSCRIPTION_CREDENTIALS[subscriptionKind].label}. Choose a model supported by that connection.`,
    );
  }
}

type RuntimeModelReadinessInput = {
  runtime: ResolvedAgentRuntime;
  agent: Pick<Agent, "llmApiKeyId" | "modelId">;
  actor: A2AActor;
};

/**
 * Validate that the Agent's LLM model selection and LLM/subscription credential
 * can be resolved for the acting principal without launching a container.
 */
export async function preflightAgentRuntimeModelReadiness(
  params: RuntimeModelReadinessInput,
  resolvedCompatibility?: Awaited<
    ReturnType<typeof preflightAgentRuntimeModelCompatibility>
  >,
) {
  const { runtime, agent, actor } = params;
  const userId = actor.kind === "user" ? actor.id : null;
  const { llm, usesClaudeCodeSubscription } =
    resolvedCompatibility ??
    (await preflightAgentRuntimeModelCompatibility({
      runtime,
      agent,
      organizationId: actor.organizationId,
      userId: userId ?? "system",
    }));

  if (usesClaudeCodeSubscription) {
    if (!userId) {
      throw new ApiError(
        409,
        "A personal Claude subscription requires a run acting as a signed-in user.",
      );
    }
    const account = await claudeCodeAccountManager.status({
      runtime,
      userId,
      inspectFlow: false,
    });
    if (account.state !== "connected") {
      throw new AgentRuntimeCredentialsRequiredError(runtime.agentId, [
        {
          key: "CLAUDE_CODE_ACCOUNT",
          label: "Claude Code account",
          description:
            "Connect your personal Claude account in Account connections.",
        },
      ]);
    }
    return;
  }

  if (isCodexRuntimeCommand(runtime.command?.[0])) {
    const requiredSubscription = userId
      ? await LlmProviderApiKeyModel.findPersonalSubscriptionKey({
          organizationId: actor.organizationId,
          userId,
          kind: "chatgpt",
        })
      : null;
    if (!requiredSubscription) {
      throw new ApiError(
        409,
        `Connect your own ${SUBSCRIPTION_CREDENTIALS.chatgpt.label} before starting this Agent. The maintained runtime never falls back to usage-based API billing.`,
      );
    }
    await ensureProviderApiKeySupportsSelectedModel({
      providerApiKey: requiredSubscription.apiKey,
      provider: llm.selectedProvider,
      model: llm.selectedModel,
      subscriptionCredential: {
        kind: "chatgpt",
        apiKeyValue: requiredSubscription.apiKeyValue,
      },
    });
    return;
  }

  if (
    llm.modelId !== null ||
    agent.llmApiKeyId !== null ||
    llm.chatApiKeyId !== null ||
    providerRequiresPerUserCredential(llm.selectedProvider)
  ) {
    const resolvedProviderCredential = await resolveProviderApiKey({
      organizationId: actor.organizationId,
      userId:
        actor.kind === "serviceAccount"
          ? serviceAccountUserId(actor.id)
          : (userId ?? undefined),
      provider: llm.selectedProvider,
      agentLlmApiKeyId: agent.llmApiKeyId ?? undefined,
      modelName: llm.selectedModel,
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
        `No ${providerDisplayNames[llm.selectedProvider]} credential is available for this Agent and user, so the Agent Runtime run cannot use its selected model.`,
      );
    }
    await ensureProviderApiKeySupportsSelectedModel({
      providerApiKey,
      provider: llm.selectedProvider,
      model: llm.selectedModel,
    });
  }
}

/**
 * Returns whether the acting principal can satisfy the Agent's LLM model and
 * subscription/provider credential requirements. Used by load-balanced subagent
 * selection to skip candidates for which the actor lacks subscription/provider
 * credentials before claiming a slot or creating a failed run record.
 */
export async function canLaunchAgentRuntimeModel(
  params: RuntimeModelReadinessInput,
): Promise<boolean> {
  try {
    await preflightAgentRuntimeModelReadiness(params);
    return true;
  } catch (error) {
    if (
      error instanceof ApiError ||
      error instanceof AgentRuntimeCredentialsRequiredError
    ) {
      return false;
    }
    logger.warn(
      { err: error, agentId: params.runtime.agentId },
      "Unexpected error checking runtime model readiness; marking candidate unready",
    );
    return false;
  }
}

/** Reject actionable setup failures before returning a detached task handle. */
export async function preflightAgentRuntimeLaunch(params: {
  runtime: ResolvedAgentRuntime;
  agent: Agent;
  actor: A2AActor;
  ephemeralCredentials?: Record<string, string>;
}) {
  const { runtime, agent, actor } = params;
  const userId = actor.kind === "user" ? actor.id : null;
  await prepareAgentRuntimeBackendDriver(runtime.backend);
  const modelCompatibility = await preflightAgentRuntimeModelCompatibility({
    runtime,
    agent,
    organizationId: actor.organizationId,
    userId: userId ?? "system",
  });
  const credentials = await preflightAgentRuntimeCredentials({
    runtime,
    organizationId: actor.organizationId,
    userId,
    authorizationUserId:
      actor.kind === "serviceAccount" ? serviceAccountUserId(actor.id) : userId,
    ephemeralCredentials: params.ephemeralCredentials,
  });
  if (credentials.misconfigured.length > 0) {
    throw new ApiError(
      409,
      `This Agent's Agent Runtime is missing shared credentials an administrator must configure: ${credentials.misconfigured.map((entry) => entry.label).join(", ")}`,
    );
  }
  if (credentials.missing.length > 0) {
    throw new AgentRuntimeCredentialsRequiredError(
      runtime.agentId,
      credentials.missing,
    );
  }
  await preflightAgentRuntimeModelReadiness(
    { runtime, agent, actor },
    modelCompatibility,
  );
}
