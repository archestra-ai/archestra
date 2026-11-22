import {
  COMPANY_ACCOUNT_WORDS,
  providerDisplayNames,
  providerRequiresPerUserCredential,
  SUBSCRIPTION_CREDENTIALS,
  type SubscriptionCredentialKind,
  type SupportedProvider,
} from "@archestra/shared";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import { serviceAccountUserId } from "@/auth/service-account-user-id";
import {
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
} from "@/models";
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
import { preflightAgentRuntimeModelCompatibility } from "./model-compatibility";

/** Reject actionable setup failures before returning a detached task handle. */
export async function preflightAgentRuntimeLaunch(params: {
  runtime: ResolvedAgentRuntime;
  agent: Agent;
  actor: A2AActor;
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
 * Validate that the Agent's LLM model selection and LLM/subscription credential
 * can be resolved for the acting principal without launching a container.
 */
async function preflightAgentRuntimeModelReadiness(
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
  /** The runtime's launch command. */
  runtimeCommand: string | null | undefined;
}): Promise<LlmProviderApiKey> {
  const { account } = params;
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
          ? choiceError("Its API key no longer exists.").error
          : "This agent's API key no longer exists. Someone who can configure its runtime must choose another or change its lock.",
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
        chooseConnectionMessage(
          COMPANY_ACCOUNT_WORDS,
          params.actor.kind === "user",
        ),
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
  if (requiredSubscription?.apiKeyValue && subscriptionKind) {
    await ensureSubscriptionServesModel({
      providerApiKey,
      provider: params.provider,
      model: params.model,
      subscription: {
        kind: subscriptionKind,
        apiKeyValue: requiredSubscription.apiKeyValue,
      },
    });
  }
  return providerApiKey;
}

/**
 * Why the account a run of this agent would use cannot bind, as the setup
 * check reports it: null when it binds, or when a credential is what is
 * missing, which the setup check lists on its own.
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

// ===================================================================
// Internal
// ===================================================================

type RuntimeModelReadinessInput = {
  runtime: ResolvedAgentRuntime;
  agent: Pick<Agent, "llmApiKeyId" | "modelId">;
  actor: A2AActor;
};

/**
 * A person's subscription serves its own models only. It may have been
 * synced before the selected model was released: refresh that connection
 * once rather than bypass the router's model links.
 */
async function ensureSubscriptionServesModel(params: {
  providerApiKey: LlmProviderApiKey;
  provider: SupportedProvider;
  model: string;
  subscription: { kind: SubscriptionCredentialKind; apiKeyValue: string };
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
  if (await hasSelectedModel()) return;
  await modelSyncService.syncModelsForApiKey({
    apiKeyId: providerApiKey.id,
    provider: providerApiKey.provider,
    apiKeyValue: params.subscription.apiKeyValue,
  });
  if (!(await hasSelectedModel())) {
    throw new ApiError(
      409,
      `The selected model "${model}" is not available through your ${SUBSCRIPTION_CREDENTIALS[params.subscription.kind].label}. Choose a model supported by that connection.`,
    );
  }
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
