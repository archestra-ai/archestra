import {
  COMPANY_ACCOUNT_WORDS,
  DEFAULT_CLAUDE_CODE_MODEL,
  getAgentRuntimeDefaultModelCompatibility,
  getAgentRuntimeModelCompatibility,
  isClaudeCodeRuntimeCommand,
  isCodexRuntimeCommand,
  providerRequiresPerUserCredential,
  runtimeRequestsClaudeSubscription,
  runtimeSupportsClaudeSubscription,
  SUBSCRIPTION_CREDENTIALS,
  type SupportedProvider,
  subscriptionKindForProvider,
  subscriptionKindForRuntimeCommand,
  withClaudeAccountItRuns,
} from "@archestra/shared";
import { getAgentTypePermissionChecker } from "@/auth/agent-type-permissions";
import config from "@/config";
import {
  AgentModel,
  AgentTeamModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
} from "@/models";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import type {
  Agent,
  AgentRuntimeAccountLock,
  Model,
  ResolvedAgentRuntime,
} from "@/types";
import { ApiError, OWN_ACCOUNT_ONLY } from "@/types";
import {
  type ConversationLlmSelection,
  resolveConversationLlmSelectionForAgent,
} from "@/utils/llm-resolution";
import {
  type AccountInputs,
  type AgentRuntimeRunAccount,
  agentRuntimeFor,
  CLAUDE_SUBSCRIPTION_PROTOCOL_MESSAGE,
  type CompanyOption,
  choiceError,
  chooseConnectionMessage,
  chooseModelMessage,
  claudeAccountNamedByRuntime,
  findOwnSubscriptionKey,
  loadPersonAccountChoice,
  ownAccountInputs,
  resolveCompanyOption,
  runsForPerson,
  runtimeAccountKind,
  withRuntimeAccountRule,
} from "./account-resolution";

/**
 * Resolve the model an Agent Runtime run would receive and reject an image
 * protocol that cannot serve it. This only reads model configuration, so task
 * callers can use it before creating a detached task.
 */
export async function preflightAgentRuntimeModelCompatibility(
  params: ModelCompatibilityParams,
) {
  const result = await getResolvedAgentRuntimeModelCompatibility(params);
  if (result.accountError) throw new ApiError(409, result.accountError);
  if (!result.compatibility.compatible) {
    throw new ApiError(409, result.compatibility.message);
  }
  return result;
}

/**
 * The way the agent's own settings run a person's runs while they have no
 * choice of their own, under the lock its runtime holds it to.
 */
export async function agentOwnAuthentication(params: {
  agent: Pick<Agent, "llmApiKeyId" | "modelId">;
  runtime: Pick<
    ResolvedAgentRuntime,
    "image" | "command" | "inferenceProtocol" | "claudeCode"
  > & { accountLock?: ResolvedAgentRuntime["accountLock"] };
  organizationId: string;
  userId: string;
}): Promise<"subscription" | "provider"> {
  const runtime = {
    ...params.runtime,
    accountLock: params.runtime.accountLock ?? null,
  };
  if (runtimeSupportsClaudeSubscription(runtime)) {
    const { usesClaudeCodeSubscription } =
      await getResolvedAgentRuntimeModelCompatibility({
        ...params,
        runtime,
        asStored: true,
      });
    return usesClaudeCodeSubscription ? "subscription" : "provider";
  }
  // The maintained Codex runtime runs on each person's ChatGPT subscription
  // unless a company-key lock puts it on its stored key.
  if (isCodexRuntimeCommand(runtime.command?.[0])) {
    return runtime.accountLock === "key" ? "provider" : "subscription";
  }
  // A runtime with a subscription of its own can be locked to it whatever
  // key the agent stores: its runs then bind each person's subscription.
  if (
    runtime.accountLock === "subscription" &&
    subscriptionKindForRuntimeCommand(runtime.command?.[0])
  ) {
    return "subscription";
  }
  return (await storesPersonalCredential(params.agent))
    ? "subscription"
    : "provider";
}

type ModelCompatibilityParams = {
  /** With its image, by which the runtime's own account rule is found. */
  runtime: Pick<
    ResolvedAgentRuntime,
    | "image"
    | "command"
    | "inferenceProtocol"
    | "claudeCode"
    | "accountLock"
  >;
  agent: Pick<Agent, "llmApiKeyId" | "modelId">;
  organizationId: string;
  userId: string;
  /**
   * The agent whose run this is. With it, the account `userId` chose for
   * their own runs of the agent applies; without it, the agent's own account.
   */
  agentId?: string;
  /**
   * Check the runtime against the model and key the agent stores, as its runs
   * use them, instead of against what `userId` may use. For a write that keeps
   * the agent's pair, the caller's own keys do not matter: a release that
   * moves an agent to a new image is not choosing its model. Ignores any
   * person's own choice, and the account rule of the agent's runtime: what
   * is judged is what the agent stores.
   */
  asStored?: boolean;
  /**
   * Judge the agent's own settings without the account rule its runtime's
   * settings lay over them. For a write, which stores the agent's own: the
   * rule governs the agent's runs, not what may be saved on it.
   */
  withoutRuntimeRule?: boolean;
};

/**
 * The lock a runtime's `accountLock` amounts to for a person's choice. A
 * runtime that names none runs only the way the agent's own settings say:
 * each person's subscription, or a company API key. It decides what a
 * person may choose, not what such an agent's runs are held to: those
 * resolve from the agent's own settings, the organization's default
 * included when the agent stores no key.
 */
async function concreteAccountLock(
  params: Pick<
    ModelCompatibilityParams,
    "runtime" | "agent" | "organizationId" | "userId"
  >,
): Promise<AgentRuntimeAccountLock | null> {
  const { accountLock } = params.runtime;
  if (accountLock !== OWN_ACCOUNT_ONLY) return accountLock;
  return (await ownAuthentication(params)) === "subscription"
    ? "subscription"
    : "key";
}

/**
 * The account, model and key a run of the agent resolves to. The agent's own
 * account settings enter here, and only here, with the account rule of its
 * runtime laid over them (`withRuntimeAccountRule`): a launch, a preflight
 * and the account routes all resolve through this, so they agree. `inputs`
 * are those settings as resolved, for a caller that reports the agent's
 * account.
 *
 * The company API key resolves by one rule at three levels: its connection
 * and its model are each the runtime's, else the agent's, else the person's
 * own choice, else the organization's default. What a level sets holds for
 * everyone below it.
 */
export async function getResolvedAgentRuntimeModelCompatibility(
  params: ModelCompatibilityParams,
) {
  const stored = {
    runtime: params.runtime,
    agent: {
      llmApiKeyId: params.agent.llmApiKeyId,
      modelId: params.agent.modelId,
    },
  };
  const inputs =
    params.asStored || params.withoutRuntimeRule
      ? ownAccountInputs(stored)
      : await withRuntimeAccountRule({
          ...stored,
          organizationId: params.organizationId,
        });
  return {
    ...(await resolveAccount({ ...params, ...inputs })),
    inputs,
  };
}

async function resolveAccount(
  resolving: ModelCompatibilityParams &
    Pick<AccountInputs, "own" | "fixedBy" | "companyProblem">,
) {
  // Who may choose is decided by the lock the runtime amounts to. What the
  // run is held to is the lock it names: a runtime that names none resolves
  // its account from the agent's own settings alone.
  const choiceLock = await concreteAccountLock({
    ...resolving,
    agent: resolving.own,
  });
  let params = resolving;
  const lock =
    params.runtime.accountLock === OWN_ACCOUNT_ONLY
      ? null
      : params.runtime.accountLock;
  const runtime = { ...params.runtime, accountLock: lock };
  const words = COMPANY_ACCOUNT_WORDS;
  const isCodexRuntime = isCodexRuntimeCommand(runtime.command?.[0]);
  // An agent saved before people could choose its account, with nothing of
  // its runtime's rule over it, resolves what it stores as it always did. A
  // connection it stores without a model sets no company connection: the
  // organization's default runs, on that connection where it serves the
  // default's provider.
  const asSaved =
    params.runtime.accountLock === OWN_ACCOUNT_ONLY &&
    params.fixedBy.connection !== "runtime" &&
    params.fixedBy.model !== "runtime";
  const choice = params.asStored
    ? null
    : await loadPersonAccountChoice({
        agentId: params.agentId,
        userId: params.userId,
        agent: params.agent,
        fixedBy: params.fixedBy,
        runtime,
        organizationId: params.organizationId,
        lock: choiceLock,
        companyProblem: params.companyProblem,
      });
  const usableChoice = choice && "authentication" in choice ? choice : null;
  const providerChoice =
    usableChoice?.authentication === "provider" ? usableChoice : null;
  const subscriptionChoice =
    usableChoice?.authentication === "subscription" ? usableChoice : null;
  const claudeCapable = runtimeSupportsClaudeSubscription(runtime);
  // The connection and model a runtime fixes are the company API key's. A
  // run on a personal subscription keeps the agent's own: its model, and on
  // a runtime where the stored connection says whose subscription that is,
  // its connection. So fixing a connection without naming a kind moves no
  // agent from each person's subscription to the company option.
  const onOwnSubscription =
    params.fixedBy.connection === "runtime" &&
    !claudeCapable &&
    !providerChoice &&
    lock !== "key" &&
    (!!subscriptionChoice ||
      lock === "subscription" ||
      (!usableChoice &&
        (isCodexRuntime || (await storesPersonalCredential(params.own)))));
  if (onOwnSubscription) {
    params = {
      ...params,
      agent: params.own,
      fixedBy: {
        connection: params.own.llmApiKeyId ? "agent" : null,
        model: params.own.modelId ? "agent" : null,
      },
      companyProblem: null,
    };
  }
  // A person's choice overrides the runtime's Claude account setting. The
  // agent's account lock does not: saving a lock checks that setting agrees.
  const authentication = usableChoice
    ? usableChoice.authentication
    : runtime.claudeCode?.authentication;
  const effectiveRuntime = {
    ...runtime,
    claudeCode:
      claudeCapable && authentication
        ? { ...runtime.claudeCode, authentication }
        : runtime.claudeCode,
  };
  // A person's own Claude subscription runs the model they picked for it,
  // else the one the agent sets.
  const claudeSubscriptionModel = () =>
    subscriptionChoice
      ? (subscriptionChoice.claudeModel ??
        subscriptionChoice.model?.modelId ??
        runtime.claudeCode?.model ??
        DEFAULT_CLAUDE_CODE_MODEL)
      : (runtime.claudeCode?.model ?? DEFAULT_CLAUDE_CODE_MODEL);
  const onClaudeSubscriptionPath =
    runtimeRequestsClaudeSubscription(effectiveRuntime) &&
    authentication === "subscription";
  // The company API key with no connection set or chosen at any level
  // resolves the organization's default among company connections only, and
  // binds the one that gives: never a key or a subscription of the person's
  // own, which they run on only by picking it. An agent saved before people
  // could choose, on a runtime that names no account kind, resolves as it
  // always did.
  const companyConnectionsOnly =
    !params.asStored &&
    params.runtime.accountLock !== OWN_ACCOUNT_ONLY &&
    (providerChoice ? !providerChoice.key : !params.agent.llmApiKeyId) &&
    (!!providerChoice ||
      (!usableChoice && (lock === "key" || (!lock && !isCodexRuntime))));

  // The company API key as the agent and its runtime set it. A connection
  // set with its model is the pair an agent always stored, and resolves as
  // it always did. A connection set without one leaves the model to each
  // person: the organization's default where the connection serves it,
  // until they pick. A person's company-key choice carries all of it.
  const fixedPair = !!params.agent.llmApiKeyId && !!params.agent.modelId;
  const openModel =
    !params.asStored &&
    !asSaved &&
    !providerChoice &&
    !params.companyProblem &&
    !!params.agent.llmApiKeyId &&
    !params.agent.modelId
      ? await resolveCompanyOption({
          runtime,
          organizationId: params.organizationId,
          agent: params.agent,
          fixedBy: params.fixedBy,
        })
      : null;
  const company: CompanyOption | null =
    providerChoice ??
    (openModel && !("problem" in openModel) ? openModel : null);
  // Why the connection the agent sets alone cannot run.
  const brokenConnection =
    openModel && "problem" in openModel ? openModel.problem.stale : null;
  const companySelection: ConversationLlmSelection | null =
    company?.key && company.model
      ? {
          modelId: company.model.id,
          chatApiKeyId: company.key.id,
          selectedModel: company.model.modelId,
          selectedProvider: company.model.provider,
        }
      : null;
  // A `key` lock runs the pair the agent stores as it is: once that pair no
  // longer holds together, the run is refused, never moved to another.
  const storedSelection =
    !onClaudeSubscriptionPath &&
    !providerChoice &&
    !subscriptionChoice?.model &&
    (params.asStored || (lock === "key" && fixedPair))
      ? await storedAgentLlmSelection(params)
      : null;
  const keyLockPairBroken =
    lock === "key" &&
    fixedPair &&
    !params.asStored &&
    !onClaudeSubscriptionPath &&
    !providerChoice &&
    !subscriptionChoice?.model &&
    !storedSelection;
  // Whether the model below comes from the organization's default: no level
  // set it and the person did not pick it.
  const modelFromDefault =
    !onClaudeSubscriptionPath &&
    !subscriptionChoice?.model &&
    !companySelection &&
    !storedSelection &&
    !(fixedPair && !providerChoice);
  let llm: ConversationLlmSelection = onClaudeSubscriptionPath
    ? {
        modelId: null,
        chatApiKeyId: null,
        selectedModel: claudeSubscriptionModel(),
        selectedProvider: "anthropic" as const,
      }
    : subscriptionChoice?.model
      ? {
          modelId: subscriptionChoice.model.id,
          chatApiKeyId: null,
          selectedModel: subscriptionChoice.model.modelId,
          selectedProvider: subscriptionChoice.model.provider,
        }
      : (companySelection ??
        storedSelection ??
        (await resolveConversationLlmSelectionForAgent({
          // Only a whole pair of the agent's reaches this chain, and the
          // connection an agent saved before people could choose stores
          // alone. With no connection at any level it gives the
          // organization's default, as it does for an agent that stores none.
          agent: providerChoice
            ? { llmApiKeyId: null, modelId: null }
            : fixedPair
              ? params.agent
              : asSaved
                ? params.own
                : { llmApiKeyId: null, modelId: null },
          organizationId: params.organizationId,
          userId: params.userId,
          includeMemberChatDefault: false,
          companyConnectionsOnly,
        })));
  const defaultModelKept = modelFromDefault;
  // Whether Bedrock or Vertex keeps an unset Claude account off the
  // subscription path is decided on the model the agent's settings resolve.
  const usesClaudeCodeSubscription =
    runtimeRequestsClaudeSubscription(effectiveRuntime) &&
    !getClaudeCodeCloudProvider({
      runtime: effectiveRuntime,
      provider: llm.selectedProvider,
    });
  if (usesClaudeCodeSubscription) {
    llm = {
      modelId: null,
      chatApiKeyId: null,
      selectedProvider: "anthropic",
      selectedModel: claudeSubscriptionModel(),
    };
  }
  // The model in effect is one nobody set or chose. Where it cannot run, it
  // counts as no model: nobody chose it, so there is no incompatibility to
  // report, and the person has a model or a connection to pick.
  const modelNobodySet = defaultModelKept && !usesClaudeCodeSubscription;
  // The cloud the run talks to, judged on the model it finally runs (as the
  // launch spec always has), so it can differ from the decision above.
  const claudeCodeCloudProvider = getClaudeCodeCloudProvider({
    runtime: effectiveRuntime,
    provider: llm.selectedProvider,
  });
  const selectedModel = llm.modelId
    ? await ModelModel.findById(llm.modelId)
    : null;
  const compatibility =
    usesClaudeCodeSubscription && runtime.inferenceProtocol !== "anthropic"
      ? {
          compatible: false as const,
          message: CLAUDE_SUBSCRIPTION_PROTOCOL_MESSAGE,
        }
      : getAgentRuntimeModelCompatibility({
          inferenceProtocol: runtime.inferenceProtocol,
          runtimeCommand: runtime.command,
          provider: llm.selectedProvider,
          modelId: llm.selectedModel,
          supportedEndpoints: selectedModel?.supportedEndpoints,
        });

  let account: AgentRuntimeRunAccount;
  let accountError: string | null =
    choice && "error" in choice
      ? choice.error
      : keyLockPairBroken
        ? keyLockBrokenPairMessage()
        : null;
  let accountErrorFromChoice =
    !!choice && "error" in choice && !choice.companyOption;
  let accountErrorFromModel = false;
  // A part nobody set is a person's to pick. A run with no person behind
  // it is told who can set it instead.
  const forPerson = runsForPerson(params.userId);
  // The runtime's own subscription where it has one; on any other runtime an
  // agent whose own key is somebody's subscription still runs on the one its
  // model's provider has.
  const personalSubscriptionKind = usesClaudeCodeSubscription
    ? null
    : (subscriptionKindForRuntimeCommand(runtime.command?.[0]) ??
      subscriptionKindForProvider(llm.selectedProvider));
  // A model someone set or picked that no personal subscription serves. One
  // nobody set is not reported so: the person picks a model instead (below).
  const setModelWithoutSubscription =
    !usesClaudeCodeSubscription && !personalSubscriptionKind && !modelNobodySet;
  if (providerChoice) {
    account = {
      source: "choice",
      authentication: "provider",
      ...(providerChoice.key && { keyId: providerChoice.key.id }),
    };
  } else if (usableChoice) {
    account = {
      source: "choice",
      authentication: "subscription",
      subscriptionKind: personalSubscriptionKind,
    };
    if (setModelWithoutSubscription) {
      accountError = choiceError(
        `${llm.selectedModel} has no personal subscription.`,
      ).error;
      accountErrorFromChoice = true;
    }
  } else if (lock === "subscription") {
    account = { source: "agent", subscriptionKind: personalSubscriptionKind };
    if (setModelWithoutSubscription) {
      accountError = `This agent is locked to each person's own subscription, but ${llm.selectedModel} has none. Someone who can configure its runtime must change its model or its lock.`;
    }
  } else if (lock === "key") {
    // The connection the agent or its runtime sets, bound as it is: the
    // maintained Codex runtime stops needing ChatGPT.
    account = {
      source: "agent",
      subscriptionKind: null,
      ...(params.agent.llmApiKeyId && { keyId: params.agent.llmApiKeyId }),
    };
  } else {
    account = {
      source: "agent",
      subscriptionKind: isCodexRuntime ? "chatgpt" : null,
    };
  }
  const boundSubscription =
    "subscriptionKind" in account ? account.subscriptionKind : null;
  // A run on a personal subscription: one the person chose, or the one the
  // agent's lock or its runtime puts them on.
  const onPersonalSubscription =
    !usesClaudeCodeSubscription &&
    !providerChoice &&
    (!!usableChoice || lock === "subscription" || !!boundSubscription);
  // A subscription serves its own provider's models only. The model in
  // effect is the one the person picked for it, else the agent's, which can
  // belong to another provider: the person fixes that by picking a model,
  // not by choosing their account again.
  const servedBySubscription =
    !!boundSubscription &&
    SUBSCRIPTION_CREDENTIALS[boundSubscription].provider ===
      llm.selectedProvider;
  // A model nobody set that cannot run on the person's subscription counts
  // as none, as the company API key's default does below: the runtime
  // cannot run it, or the subscription does not serve it. The person picks
  // one of their subscription's models, once they have signed in to it:
  // until then, signing in is what the run asks for.
  const unfitSubscriptionDefault =
    onPersonalSubscription &&
    modelNobodySet &&
    !accountError &&
    !runtimeRunsNoModel(runtime) &&
    (!compatibility.compatible || !servedBySubscription);
  if (unfitSubscriptionDefault) {
    const signedIn =
      !forPerson ||
      !boundSubscription ||
      !!(await findOwnSubscriptionKey({
        organizationId: params.organizationId,
        userId: params.userId,
        kind: boundSubscription,
      }));
    if (signedIn) {
      accountError = chooseModelMessage(forPerson);
      accountErrorFromModel = true;
    }
  } else if (
    !accountError &&
    compatibility.compatible &&
    boundSubscription &&
    !servedBySubscription
  ) {
    accountError = `This agent's model is not available through your ${SUBSCRIPTION_CREDENTIALS[boundSubscription].label}. Choose a model on the agent's page.`;
    accountErrorFromModel = true;
  }
  // What follows is about the company API key: a run on a subscription
  // does not need it, any other is refused while it cannot run.
  const onCompanyOption = !usesClaudeCodeSubscription && !boundSubscription;
  // A connection is set and nobody set or chose its model.
  const needsModel = onCompanyOption && !!company?.key && !company.model;
  // No level names a connection, so the organization's default is what
  // resolved, and this runtime cannot run it. Such a default counts as none
  // for this agent: nobody chose it, so it is no incompatibility to report,
  // and the person has a connection to choose.
  const unfitDefault =
    onCompanyOption &&
    !params.companyProblem &&
    !brokenConnection &&
    !company?.key &&
    !fixedPair &&
    !compatibility.compatible &&
    !runtimeRunsNoModel(runtime);
  let accountErrorFromConnection = false;
  if (onCompanyOption && params.companyProblem) {
    accountError = params.companyProblem;
    accountErrorFromChoice = false;
  } else if (onCompanyOption && !accountError && brokenConnection) {
    accountError = `${brokenConnection} Someone who can edit the agent must choose its API key again.`;
  } else if (needsModel && !accountError) {
    accountError = chooseModelMessage(forPerson);
    accountErrorFromModel = true;
  } else if (unfitDefault && !accountError) {
    accountError = chooseConnectionMessage(words, forPerson);
    accountErrorFromConnection = true;
  } else if (
    onCompanyOption &&
    companyConnectionsOnly &&
    !accountError &&
    !("authentication" in account && account.authentication !== "provider")
  ) {
    if (llm.chatApiKeyId) {
      // The company connection the default gave is bound as it is.
      account = { ...account, keyId: llm.chatApiKeyId };
    } else if (
      // Where no model resolves at all and nothing asks for a company
      // connection, the run needs no credential, as it never did.
      llm.modelId !== null ||
      account.source === "choice" ||
      lock === "key" ||
      providerRequiresPerUserCredential(llm.selectedProvider)
    ) {
      accountError = chooseConnectionMessage(words, forPerson);
      accountErrorFromConnection = true;
    }
  }

  return {
    // No model is in effect while the person has one to choose, or a
    // connection to choose first.
    compatibility:
      needsModel ||
      unfitDefault ||
      unfitSubscriptionDefault
        ? { compatible: true as const }
        : compatibility,
    llm,
    selectedModel,
    usesClaudeCodeSubscription,
    claudeCodeCloudProvider,
    account,
    /**
     * The connection the company API key resolves to for this run: the one
     * the agent, its runtime or the person names. Null when none does, and
     * the organization's default applies.
     */
    companyConnectionId: providerChoice
      ? (providerChoice.key?.id ?? null)
      : asSaved
        ? params.own.llmApiKeyId
        : params.agent.llmApiKeyId,
    /** Why the account cannot run; the run is refused. */
    accountError,
    /**
     * Whether `accountError` is about the person's own choice, which they can
     * change, rather than the agent's account or its lock.
     */
    accountErrorFromChoice: !!accountError && accountErrorFromChoice,
    /**
     * Whether `accountError` is that the account in effect has no model to
     * run: the person fixes it by picking one, of their subscription or of
     * the company API key's connection.
     */
    accountErrorFromModel,
    /**
     * Whether `accountError` is that the company API key has no connection:
     * nobody set or chose one, and the organization's default is none this
     * runtime can run. Where the default gives no connection at all, binding
     * the run's key is what finds it (`runAccountBindProblem`).
     */
    accountErrorFromConnection,
    /** Why the agent's account lock sets the person's own choice aside. */
    choiceIgnored: choice && "ignored" in choice ? choice.ignored : null,
    /** The lock this run is held to: null when the runtime names none. */
    accountLock: lock,
    /**
     * The agent was saved before people could choose its account, and
     * nothing of its runtime's rule is over it: what it stores resolves as
     * it always did.
     */
    asSaved,
    /** The lock a person's choice is held to, with "none named" worked out. */
    choiceLock,
  };
}

/**
 * The organization's default as one person's runs on the company API key
 * resolve it for a runtime, when no level names a connection. Null when it
 * resolves no model, or one the runtime cannot run: such a default counts
 * as none, and the person has a connection to choose.
 */
export async function organizationDefaultForRuntime(params: {
  runtime: Pick<
    ResolvedAgentRuntime,
    "command" | "inferenceProtocol" | "accountLock"
  >;
  organizationId: string;
  userId: string;
}): Promise<ConversationLlmSelection | null> {
  // As a run resolves it: among company connections, except for an agent
  // stored without a lock, which runs only the way its own settings say.
  const companyConnectionsOnly =
    params.runtime.accountLock !== OWN_ACCOUNT_ONLY;
  const llm = await resolveConversationLlmSelectionForAgent({
    agent: { llmApiKeyId: null, modelId: null },
    organizationId: params.organizationId,
    userId: params.userId,
    includeMemberChatDefault: false,
    companyConnectionsOnly,
  });
  if (!llm.modelId) return null;
  const model = await ModelModel.findById(llm.modelId);
  return model &&
    getAgentRuntimeModelCompatibility({
      inferenceProtocol: params.runtime.inferenceProtocol,
      runtimeCommand: params.runtime.command,
      provider: llm.selectedProvider,
      modelId: llm.selectedModel,
      supportedEndpoints: model.supportedEndpoints,
    }).compatible
    ? llm
    : null;
}

/**
 * The pair the agent sets under a lock to the company option, where its
 * connection no longer serves its model. A deleted connection or model is
 * not this: it leaves that part to each person.
 */
function keyLockBrokenPairMessage(): string {
  return "This agent is locked to a company API key, but its own API key no longer serves its model. Someone who can edit the agent must choose them again.";
}

/**
 * The model and key an agent stores, whoever asks. Null when the pair is
 * incomplete, gone, or no longer linked: a run then resolves its model from
 * the organization's defaults, and so does the caller here.
 */
async function storedAgentLlmSelection(params: {
  agent: Pick<Agent, "llmApiKeyId" | "modelId">;
  organizationId: string;
}): Promise<ConversationLlmSelection | null> {
  const { llmApiKeyId, modelId } = params.agent;
  if (!llmApiKeyId || !modelId) return null;
  const [model, key, linked] = await Promise.all([
    ModelModel.findById(modelId),
    LlmProviderApiKeyModel.findById(llmApiKeyId),
    LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds([llmApiKeyId]),
  ]);
  if (
    !model ||
    !key ||
    key.organizationId !== params.organizationId ||
    !linked.some((link) => link.model.id === modelId)
  ) {
    return null;
  }
  return {
    modelId: model.id,
    chatApiKeyId: key.id,
    selectedModel: model.modelId,
    selectedProvider: model.provider,
  };
}

/**
 * Agent Runtime agents that run on the organization's default model, so a
 * new default must suit their runtimes. `agents` are the ones `userId` can
 * read (all of them for a system check with no user), each with whether
 * `userId` may give it a model of its own; `hidden` are the rest, which a
 * caller may count but never see.
 */
export async function listRuntimeAgentsInheritingOrganizationDefault(params: {
  organizationId: string;
  userId?: string;
}): Promise<{
  agents: Array<
    RuntimeDependent & { id: string; name: string; canUpdate: boolean }
  >;
  hidden: RuntimeDependent[];
}> {
  const rows = (
    await AgentModel.findRuntimeAgentsInheritingOrganizationDefault(
      params.organizationId,
    )
  ).flatMap((agent) =>
    agent.runtime ? [{ ...agent, runtime: agent.runtime }] : [],
  );
  const access = params.userId
    ? await agentAccess({
        organizationId: params.organizationId,
        userId: params.userId,
        agents: rows,
      })
    : null;
  const agents: Array<
    RuntimeDependent & { id: string; name: string; canUpdate: boolean }
  > = [];
  const hidden: RuntimeDependent[] = [];
  // The account rule of an agent's runtime comes before the organization's
  // default, as it does when a run resolves its account.
  const settings =
    rows.length > 0
      ? await AgentRuntimeTemplateModel.getSettings(params.organizationId)
      : null;
  for (const row of rows) {
    const target = settings
      ? agentRuntimeFor({ runtime: row.runtime, settings })
      : null;
    // A runtime that fixes its agents' connection runs none of them on the
    // default: the model is the runtime's, the agent's or each person's.
    if (
      target?.accounts?.llmApiKeyId &&
      runtimeAccountKind(target) !== "subscription"
    ) {
      continue;
    }
    // The Claude account its rule names holds for every agent, whatever
    // the agent stores; else the one the agent runs on.
    const claudeAccount =
      claudeAccountNamedByRuntime(target) ??
      withClaudeAccountItRuns({
        runtime: row.runtime,
        savedBeforeChoosing: row.runtime.accountLock === undefined,
      }).claudeCode?.authentication;
    const runtime: RuntimeDependent = {
      runtimeCommand: row.runtime.command ?? null,
      inferenceProtocol: row.runtime.inferenceProtocol,
      ...(claudeAccount && { claudeCodeAuthentication: claudeAccount }),
    };
    if (!access || access.readable.has(row.id)) {
      agents.push({
        id: row.id,
        name: row.name,
        canUpdate: !access || access.updatable.has(row.id),
        ...runtime,
      });
    } else {
      hidden.push(runtime);
    }
  }
  return { agents, hidden };
}

/**
 * Rejects an organization default model an inheriting Agent Runtime agent
 * cannot run, naming the blocking agents `userId` can read and counting the
 * rest.
 */
export async function assertRuntimeAgentsSupportOrganizationDefault(params: {
  organizationId: string;
  /** The person saving; absent for a system check, which names every agent. */
  userId?: string;
  modelId: string | null;
}): Promise<void> {
  if (!params.modelId) return;
  const [model, dependents] = await Promise.all([
    ModelModel.findById(params.modelId),
    listRuntimeAgentsInheritingOrganizationDefault(params),
  ]);
  if (!model) {
    throw new ApiError(404, "Default model not found");
  }
  const { named, hiddenCount } = blockersOf({ model, dependents });
  const total = named.length + hiddenCount;
  if (total === 0) return;
  const one = total === 1;
  const who = [
    named.length > 0 &&
      `Agent Runtime ${named.length === 1 ? "agent" : "agents"} ${named.map(({ name }) => `"${name}"`).join(", ")}`,
    hiddenCount > 0 &&
      `${hiddenCount} Agent Runtime ${hiddenCount === 1 ? "agent" : "agents"} you can't view`,
  ]
    .filter(Boolean)
    .join(" and ");
  // A specific reason only ever comes from an agent the caller can read.
  const reason =
    named[0]?.reason ??
    `${one ? "Its runtime" : "Their runtimes"} can't use it.`;
  throw new ApiError(
    409,
    `Can't use "${model.modelId}" as the default model. ${who} ${one ? "runs" : "run"} on the default model and can't run this one: ${reason} Give ${one ? "that agent a model of its own" : "those agents models of their own"}, or choose a compatible default model.`,
  );
}

/**
 * How many inheriting Agent Runtime agents `userId` can't read would be
 * unable to run `modelId` (models.id) as the default: a count, nothing more.
 */
export async function countHiddenAgentsBlockingDefault(params: {
  organizationId: string;
  userId: string;
  modelId: string;
}): Promise<number> {
  const [model, dependents] = await Promise.all([
    ModelModel.findById(params.modelId),
    listRuntimeAgentsInheritingOrganizationDefault(params),
  ]);
  return model ? blockersOf({ model, dependents }).hiddenCount : 0;
}

// === Internal helpers ===

/** The inheriting agents that can't run `model`: readable ones named, the rest counted. */
function blockersOf(params: {
  model: Pick<Model, "provider" | "modelId" | "supportedEndpoints">;
  dependents: Awaited<
    ReturnType<typeof listRuntimeAgentsInheritingOrganizationDefault>
  >;
}) {
  const reasonFor = (agent: RuntimeDependent) => {
    const result = getAgentRuntimeDefaultModelCompatibility({
      ...agent,
      provider: params.model.provider,
      modelId: params.model.modelId,
      supportedEndpoints: params.model.supportedEndpoints,
    });
    return result.compatible ? null : result.message;
  };
  return {
    named: params.dependents.agents.flatMap((agent) => {
      const reason = reasonFor(agent);
      return reason ? [{ name: agent.name, reason }] : [];
    }),
    hiddenCount: params.dependents.hidden.filter(
      (agent) => reasonFor(agent) !== null,
    ).length,
  };
}

/** What decides whether an inheriting agent's runtime can run a default. */
type RuntimeDependent = {
  runtimeCommand: string[] | null;
  inferenceProtocol: NonNullable<Agent["runtime"]>["inferenceProtocol"];
  /** Absent when Claude Code picks the authentication automatically. */
  claudeCodeAuthentication?: "provider" | "subscription";
};

/**
 * Which of `agents` `userId` can read, by the same checks as reading one
 * agent (per-type permissions, and team visibility for anyone
 * who doesn't administer that type), and which of those it may update.
 */
async function agentAccess(params: {
  agents: Array<Pick<Agent, "id" | "agentType">>;
  userId: string;
  organizationId: string;
}): Promise<{ readable: Set<string>; updatable: Set<string> }> {
  if (params.agents.length === 0) {
    return { readable: new Set(), updatable: new Set() };
  }
  const [checker, teamVisible] = await Promise.all([
    getAgentTypePermissionChecker(params),
    AgentTeamModel.getUserAccessibleAgentIds(params.userId, false),
  ]);
  const visible = new Set(teamVisible);
  const mayRead = ({ id, agentType }: Pick<Agent, "id" | "agentType">) => {
    try {
      checker.require(agentType, { action: "read", scope: id });
      return true;
    } catch {
      return false;
    }
  };
  const readable = params.agents.filter(
    (agent) =>
      mayRead(agent) &&
      (checker.isAdmin(agent.agentType) || visible.has(agent.id)),
  );
  return {
    readable: new Set(readable.map(({ id }) => id)),
    // The same check the agent update route makes.
    updatable: new Set(
      readable
        .filter(({ id, agentType }) =>
          checker.allowsScoped({ agentType, agentId: id, action: "update" }),
        )
        .map(({ id }) => id),
    ),
  };
}

/**
 * Whether a runtime can run no model at all, whatever its provider: the
 * maintained Claude Code runtime on an image protocol that is not
 * Anthropic's. That is the runtime's own to fix, never a default or a
 * connection to replace.
 */
function runtimeRunsNoModel(
  runtime: Pick<ResolvedAgentRuntime, "command" | "inferenceProtocol">,
): boolean {
  return (
    isClaudeCodeRuntimeCommand(runtime.command?.[0]) &&
    runtime.inferenceProtocol !== "anthropic"
  );
}

/** Cloud-hosted Claude uses provider billing instead of a Claude subscription. */
function getClaudeCodeCloudProvider(params: {
  runtime: Partial<Pick<ResolvedAgentRuntime, "command" | "claudeCode">>;
  provider: SupportedProvider;
}): "bedrock" | "vertex" | null {
  const command = params.runtime.command?.[0];
  if (!isClaudeCodeRuntimeCommand(command)) {
    return null;
  }
  if (params.runtime.claudeCode?.authentication === "subscription") return null;
  if (params.provider === "bedrock") return "bedrock";
  if (
    params.provider === "anthropic" &&
    config.llm.anthropic.vertexAi.enabled
  ) {
    return "vertex";
  }
  return null;
}

/** What the agent's own settings run on, whatever any person chose. */
async function ownAuthentication(
  params: Pick<
    ModelCompatibilityParams,
    "runtime" | "agent" | "organizationId" | "userId"
  >,
): Promise<"subscription" | "provider"> {
  return agentOwnAuthentication({
    ...params,
    runtime: { ...params.runtime, accountLock: null },
  });
}

/** Whether the connection an agent stores is somebody's own subscription. */
async function storesPersonalCredential(agent: {
  llmApiKeyId: string | null;
}): Promise<boolean> {
  const key = agent.llmApiKeyId
    ? await LlmProviderApiKeyModel.findByIdWithSubscriptionInfo(
        agent.llmApiKeyId,
      )
    : null;
  return !!key && (await LlmProviderApiKeyModel.isPersonalCredential(key));
}
