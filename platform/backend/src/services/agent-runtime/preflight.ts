import {
  companyAccountWords,
  isClaudeCodeRuntimeCommand,
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
import type {
  Agent,
  AgentRuntimeAccountLock,
  LlmProviderApiKey,
  ResolvedAgentRuntime,
} from "@/types";
import { AgentRuntimeCredentialsRequiredError, ApiError } from "@/types";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";
import {
  type AgentRuntimeRunAccount,
  assertRunHonoursAccountLock,
  choiceError,
  chooseConnectionMessage,
  personalSubscriptionReason,
  requirePersonalSubscriptionKey,
  withResolvedClaudeAccount,
} from "./account-resolution";
import { prepareAgentRuntimeBackendDriver } from "./backends";
import { claudeCodeAccountManager } from "./claude-code-account";
import { preflightAgentRuntimeCredentials } from "./credentials";
import {
  getResolvedAgentRuntimeModelCompatibility,
  preflightAgentRuntimeModelCompatibility,
} from "./model-compatibility";

const LAZY_SUBSCRIPTION_SYNC_COOLDOWN_MS = 5 * TimeInMs.Minute;

const lazySubscriptionSyncCache = new Map<
  string,
  {
    subscriptionKind: SubscriptionCredentialKind | null;
    expiresAt: number;
  }
>();

async function ensureProviderApiKeySupportsSelectedModel(params: {
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
  options?: {
    /**
     * Bind a key even where no model or key resolved, as a launch does, so
     * a missing connection is found before one is started.
     */
    bindUnresolved?: boolean;
  },
) {
  const { runtime, agent, actor } = params;
  const userId = actor.kind === "user" ? actor.id : null;
  const {
    llm,
    usesClaudeCodeSubscription,
    account,
    accountLock,
    companyConnectionId,
    inputs,
  } =
    resolvedCompatibility ??
    (await preflightAgentRuntimeModelCompatibility({
      runtime,
      agent,
      agentId: runtime.agentId,
      organizationId: actor.organizationId,
      userId: userId ?? "system",
    }));

  if (usesClaudeCodeSubscription) {
    await assertRunHonoursAccountLock({
      lock: accountLock,
      companyConnectionId,
      claudeSubscription: true,
      boundKeyId: null,
      provider: llm.selectedProvider,
      runtimeCommand: runtime.command?.[0],
    });
    if (!userId) {
      throw new ApiError(
        409,
        "A personal Claude subscription requires a run acting as a signed-in user.",
      );
    }
    const claudeAccount = await claudeCodeAccountManager.status({
      runtime: withResolvedClaudeAccount(runtime, inputs.runtime),
      userId,
      inspectFlow: false,
    });
    if (claudeAccount.state !== "connected") {
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

  // A model that needs no credential at all (none pinned, none resolved, not
  // a per-person provider) has nothing to check here.
  if (
    !options?.bindUnresolved &&
    account.source === "agent" &&
    !("keyId" in account && account.keyId) &&
    !account.subscriptionKind &&
    llm.modelId === null &&
    companyConnectionId === null &&
    llm.chatApiKeyId === null &&
    !providerRequiresPerUserCredential(llm.selectedProvider)
  ) {
    await assertRunHonoursAccountLock({
      lock: accountLock,
      companyConnectionId,
      claudeSubscription: false,
      boundKeyId: null,
      provider: llm.selectedProvider,
      runtimeCommand: runtime.command?.[0],
    });
    return;
  }
  await bindRunProviderKey({
    organizationId: actor.organizationId,
    actor,
    provider: llm.selectedProvider,
    model: llm.selectedModel,
    companyConnectionId,
    account,
    accountLock,
    runtimeCommand: runtime.command?.[0],
  });
}

/**
 * The provider key a run binds, by the same steps for a launch and for a
 * preflight: the person's own subscription when the account needs one, else
 * the key the account names (a person's checked choice, or the connection
 * set for the agent under a `key` lock) as it is, else the agent's key and
 * the usual fallbacks. The result must honour the agent's account lock and
 * serve the selected model.
 */
export async function bindRunProviderKey(params: {
  organizationId: string;
  actor: A2AActor;
  provider: SupportedProvider;
  model: string;
  /** See `assertRunHonoursAccountLock`. */
  companyConnectionId: string | null;
  account: AgentRuntimeRunAccount;
  accountLock: AgentRuntimeAccountLock | null;
  /** The runtime's launch command: it decides what the messages call a key. */
  runtimeCommand: string | null | undefined;
}): Promise<LlmProviderApiKey> {
  const { account } = params;
  const words = companyAccountWords(params.runtimeCommand);
  const own = words.plan ? "plan" : "API key";
  const actorUserId = params.actor.kind === "user" ? params.actor.id : null;
  const subscriptionKind =
    "subscriptionKind" in account ? account.subscriptionKind : null;
  const requiredSubscription = await requirePersonalSubscriptionKey({
    organizationId: params.organizationId,
    userId: actorUserId,
    kind: subscriptionKind,
    reason: personalSubscriptionReason(params),
  });
  // The key the account names binds as it is: a person's choice was checked
  // against their access when the account was resolved, and a `key` lock
  // never falls back. Neither goes through the agent's pinned-key path.
  const namedKeyId =
    !requiredSubscription && "keyId" in account
      ? (account.keyId ?? null)
      : null;
  let providerApiKey: LlmProviderApiKey | null;
  if (requiredSubscription) {
    providerApiKey = requiredSubscription.apiKey;
  } else if (namedKeyId) {
    providerApiKey = await LlmProviderApiKeyModel.findById(namedKeyId);
    if (!providerApiKey) {
      throw new ApiError(
        409,
        account.source === "choice"
          ? choiceError(`Its ${own} no longer exists.`).error
          : `This agent's ${own} no longer exists. Someone who can configure its runtime must choose another or change its lock.`,
      );
    }
  } else {
    const resolved = await resolveProviderApiKey({
      organizationId: params.organizationId,
      userId:
        params.actor.kind === "serviceAccount"
          ? serviceAccountUserId(params.actor.id)
          : (actorUserId ?? undefined),
      provider: params.provider,
      agentLlmApiKeyId: params.companyConnectionId ?? undefined,
      modelName: params.model,
    });
    if (resolved.authRequired) {
      throw new ApiError(
        409,
        `Connect your own ${resolved.authRequired.providerLabel} before starting this Agent's Agent Runtime. Subscription credentials are never shared between users.`,
      );
    }
    providerApiKey = resolved.chatApiKeyId
      ? await LlmProviderApiKeyModel.findById(resolved.chatApiKeyId)
      : null;
  }
  if (!providerApiKey) {
    // With no connection set or chosen at any level, the organization's
    // default gave none either: the person has one to choose.
    if (!params.companyConnectionId) {
      throw new NoConnectionChosenError(
        chooseConnectionMessage(words, params.actor.kind === "user"),
      );
    }
    throw new ApiError(
      409,
      `No ${providerDisplayNames[params.provider]} credential is available for this Agent and user, so the Agent Runtime run cannot use its selected model.`,
    );
  }
  await assertRunHonoursAccountLock({
    lock: params.accountLock,
    companyConnectionId: params.companyConnectionId,
    claudeSubscription: false,
    boundKeyId: providerApiKey.id,
    provider: params.provider,
    runtimeCommand: params.runtimeCommand,
  });
  await ensureProviderApiKeySupportsSelectedModel({
    providerApiKey,
    provider: params.provider,
    model: params.model,
    subscriptionCredential:
      requiredSubscription?.apiKeyValue && subscriptionKind
        ? {
            kind: subscriptionKind,
            apiKeyValue: requiredSubscription.apiKeyValue,
          }
        : null,
  });
  return providerApiKey;
}

/**
 * Returns whether the acting principal can satisfy the Agent's LLM model and
 * subscription/provider credential requirements. Used by load-balanced subagent
 * selection to skip candidates for which the actor lacks subscription/provider
 * credentials before claiming a slot or creating a failed run record.
 */
/**
 * Whether a run of this agent by this actor sets the Claude token itself: it
 * is on their own Claude subscription. A credential check that runs before
 * the account is resolved passes the answer on, so it does not ask for a
 * `CLAUDE_CODE_OAUTH_TOKEN` the image declares. The account is resolved only
 * for an image that declares one; where it does not resolve the answer is no,
 * and the model check that follows says why.
 */
export async function runSetsOwnClaudeToken(
  params: RuntimeModelReadinessInput,
): Promise<boolean> {
  const { runtime, agent, actor } = params;
  if (
    isClaudeCodeRuntimeCommand(runtime.command?.[0]) ||
    !runtime.credentials?.some(({ key }) => key === "CLAUDE_CODE_OAUTH_TOKEN")
  ) {
    return false;
  }
  try {
    const { usesClaudeCodeSubscription } =
      await getResolvedAgentRuntimeModelCompatibility({
        runtime,
        agent,
        agentId: runtime.agentId,
        organizationId: actor.organizationId,
        userId: actor.kind === "user" ? actor.id : "system",
      });
    return usesClaudeCodeSubscription;
  } catch (error) {
    if (error instanceof ApiError) return false;
    throw error;
  }
}

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

/**
 * Why the account a run would bind cannot start it, or null when it can: the
 * checks a launch makes on the bound key (the agent's account lock, a
 * credential that serves the selected model), reported instead of thrown so a
 * preflight never calls ready what starting a run refuses. `fromConnection`
 * when the company API key has no connection: nobody set or chose one, and
 * the organization's default gives none. A Claude sign-in still to make is
 * not reported here: the caller lists it as a credential.
 */
export async function runAccountBindProblem(
  params: RuntimeModelReadinessInput,
  resolvedCompatibility: Awaited<
    ReturnType<typeof preflightAgentRuntimeModelCompatibility>
  >,
): Promise<{ message: string; fromConnection: boolean } | null> {
  try {
    await preflightAgentRuntimeModelReadiness(params, resolvedCompatibility, {
      bindUnresolved: true,
    });
    return null;
  } catch (error) {
    if (error instanceof AgentRuntimeCredentialsRequiredError) return null;
    if (error instanceof ApiError && error.statusCode === 409) {
      return {
        message: error.message,
        fromConnection: error instanceof NoConnectionChosenError,
      };
    }
    throw error;
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
    agentId: runtime.agentId,
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
    usesClaudeSubscription: modelCompatibility.usesClaudeCodeSubscription,
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

/**
 * A run on the company option that has no connection: none is set at any
 * level, the person chose none, and the organization's default gave none.
 * The person picks one, or someone sets one.
 */
class NoConnectionChosenError extends ApiError {
  constructor(message: string) {
    super(409, message);
    this.name = "NoConnectionChosenError";
  }
}
