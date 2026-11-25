import {
  companyAccountWords,
  runtimeSupportsClaudeSubscription,
  SUBSCRIPTION_CREDENTIALS,
  subscriptionKindForRuntimeCommand,
} from "@archestra/shared";
import { actorFromUserId } from "@/auth/service-account-user-id";
import {
  AgentRuntimeUserAccountModel,
  LlmProviderApiKeyModel,
  ModelModel,
} from "@/models";
import type { Agent, AgentRuntime, ResolvedAgentRuntime } from "@/types";
import { ApiError } from "@/types";
import type {
  AgentRuntimeAccount,
  AgentRuntimeAccountAuthentication,
  AgentRuntimeUserAccount,
} from "@/types/agent-runtime-user-account";
import type { ConversationLlmSelection } from "@/utils/llm-resolution";
import {
  type AccountFixedBy,
  accountLockAllows,
  accountLockLabel,
  companyConnectionName,
  findOwnSubscriptionKey,
  listConnectionModelsForRuntime,
  resolveCompanyOption,
  validateAccountChoice,
} from "./account-resolution";
import { claudeCodeAccountManager } from "./claude-code-account";
import {
  agentOwnAuthentication,
  getResolvedAgentRuntimeModelCompatibility,
  organizationDefaultForRuntime,
} from "./model-compatibility";

// A person's own account for their Agent Runtime runs of one agent. Stored and
// served here; runs read it in `account-resolution.ts`.

type AccountContext = {
  agent: Agent;
  runtime: ResolvedAgentRuntime;
  organizationId: string;
  userId: string;
};

export async function getAgentRuntimeAccount(
  params: AccountContext,
): Promise<AgentRuntimeAccount> {
  const { resolved, account, own } = await resolvedAccountContext(params);
  const [ownAccount, choice, subscription] = await Promise.all([
    // The agent's own way is judged on what it stores: a connection its
    // runtime fixes is the company API key's, and says nothing of whose
    // subscription the agent runs on. Under a key lock every run is on the
    // company API key.
    agentOwnAccount({
      ...account,
      agent: account.runtime.accountLock === "key" ? account.agent : own,
    }),
    AgentRuntimeUserAccountModel.find({
      agentId: params.agent.id,
      userId: params.userId,
    }),
    personalSubscription(account),
  ]);
  // An agent read as it was saved, whose own account is the company API key,
  // shows the connection and model its runs use to someone who chose no
  // company API key of their own.
  const companyAccount =
    resolved.asSaved &&
    ownAccount.authentication === "provider" &&
    choice?.authentication !== "provider"
      ? await savedCompanyAccount({
          organizationId: params.organizationId,
          agent: own,
          llm: resolved.llm,
        })
      : await resolvedCompanyAccount({ ...account, choice });
  return {
    // On a subscription the agent keeps its own connection and model; on
    // the company API key, the ones set for everyone.
    agentAccount:
      ownAccount.authentication === "subscription"
        ? ownAccount
        : { ...ownAccount, ...account.agent },
    companyKey:
      companyAccount.resolves &&
      !!companyAccount.view.connection.id &&
      !!companyAccount.view.model.id,
    companyAccount: companyAccount.view,
    choice: choice && toSelection(choice),
    // Only what the stored choice itself causes: a problem of the agent's
    // account or its lock is not the person's to fix by choosing again.
    choiceError: choice
      ? ((resolved.accountErrorFromChoice ? resolved.accountError : null) ??
        resolved.choiceIgnored)
      : null,
    lock: resolved.choiceLock,
    subscription,
  };
}

/** Save the caller's choice after checking they may use it on this runtime. */
export async function saveAgentRuntimeAccountChoice(
  params: AccountContext & {
    choice: {
      authentication: AgentRuntimeAccountAuthentication;
      llmApiKeyId?: string | null;
      modelId?: string | null;
      claudeModel?: string | null;
    };
  },
): Promise<AgentRuntimeAccount> {
  requirePerson(params.userId);
  const { authentication } = params.choice;
  const { resolved, account } = await resolvedAccountContext(params);
  const lock = resolved.choiceLock;
  if (lock && !accountLockAllows({ lock, kind: authentication })) {
    const words = companyAccountWords(account.runtime.command?.[0]);
    throw new ApiError(
      409,
      `This agent is locked to ${accountLockLabel(lock, words)}, so you cannot choose ${authentication === "subscription" ? "a personal subscription" : words.a} for it.`,
    );
  }
  const llmApiKeyId = params.choice.llmApiKeyId ?? null;
  const modelId = params.choice.modelId ?? null;
  const claudeModel = params.choice.claudeModel ?? null;
  if (
    authentication === "subscription" &&
    !(await personalSubscription(account))
  ) {
    throw new ApiError(
      400,
      "This agent's runtime cannot run on a personal subscription. Choose the company API key instead.",
    );
  }
  // What the agent's runtime sets for the company API key no longer works:
  // nothing a person picks stands in for it.
  if (authentication === "provider" && resolved.inputs.companyProblem) {
    throw new ApiError(409, resolved.inputs.companyProblem);
  }
  // The same check every run of this choice makes.
  const checked = await validateAccountChoice({
    ...account,
    choice: { authentication, llmApiKeyId, modelId, claudeModel },
    saving: true,
  });
  if ("problem" in checked) {
    throw new ApiError(checked.problem.status, checked.problem.reason);
  }
  await AgentRuntimeUserAccountModel.upsert({
    agentId: params.agent.id,
    userId: params.userId,
    authentication,
    llmApiKeyId,
    modelId,
    claudeModel,
  });
  return getAgentRuntimeAccount(params);
}

export async function clearAgentRuntimeAccountChoice(
  params: AccountContext,
): Promise<AgentRuntimeAccount> {
  requirePerson(params.userId);
  await AgentRuntimeUserAccountModel.delete({
    agentId: params.agent.id,
    userId: params.userId,
  });
  return getAgentRuntimeAccount(params);
}

// ===================================================================
// Internal helpers
// ===================================================================

/**
 * The caller's account for the agent as its runs resolve it, and the
 * agent's account settings as resolution took them: with the account rule
 * of its runtime laid over what it stores. Everything the account routes
 * report or check about the agent's account reads `account`, never the
 * stored agent, so the routes say what a run does.
 */
async function resolvedAccountContext(params: AccountContext) {
  const resolved = await getResolvedAgentRuntimeModelCompatibility({
    ...params,
    agentId: params.agent.id,
  });
  return {
    resolved,
    account: {
      organizationId: params.organizationId,
      userId: params.userId,
      runtime: { ...params.runtime, ...resolved.inputs.runtime },
      agent: resolved.inputs.agent,
      fixedBy: resolved.inputs.fixedBy,
    },
    /** The connection and model the agent itself stores. */
    own: resolved.inputs.own,
  };
}

/**
 * The company API key as the caller's runs resolve it right now, by the
 * rule every run follows (`resolveCompanyOption`): what the agent's runtime
 * and the agent set, then what the caller chose, then the organization's
 * default. `resolves` is false while a part that is set or chosen no longer
 * works; only what the levels above set is then reported.
 */
async function resolvedCompanyAccount(params: {
  runtime: ResolvedAgentRuntime;
  organizationId: string;
  userId: string;
  agent: Pick<Agent, "llmApiKeyId" | "modelId">;
  fixedBy: AccountFixedBy;
  choice: AgentRuntimeUserAccount | null;
}): Promise<{
  resolves: boolean;
  view: AgentRuntimeAccount["companyAccount"];
}> {
  const { agent, fixedBy, choice } = params;
  const option = await resolveCompanyOption({
    runtime: params.runtime,
    organizationId: params.organizationId,
    agent,
    fixedBy,
    chosen:
      choice?.authentication === "provider"
        ? {
            userId: params.userId,
            llmApiKeyId: choice.llmApiKeyId,
            modelId: choice.modelId,
            llmApiKeyChosen: choice.llmApiKeyChosen,
            modelChosen: choice.modelChosen,
          }
        : null,
  });
  const resolves = !("problem" in option);
  // With no connection at any level, the organization's default resolves
  // as it does for an agent that stores none, where this runtime can run
  // it: one it cannot run counts as none.
  const organizationDefault =
    resolves && !option.key
      ? await organizationDefaultForRuntime({
          runtime: params.runtime,
          organizationId: params.organizationId,
          userId: params.userId,
          connectionModels: fixedBy.connectionModels,
        })
      : null;
  const [key, model] = await Promise.all([
    resolves && option.key
      ? option.key
      : organizationDefault?.chatApiKeyId
        ? LlmProviderApiKeyModel.findById(organizationDefault.chatApiKeyId)
        : fixedBy.connection && agent.llmApiKeyId
          ? LlmProviderApiKeyModel.findById(agent.llmApiKeyId)
          : null,
    resolves && option.model
      ? option.model
      : organizationDefault?.modelId
        ? ModelModel.findById(organizationDefault.modelId)
        : fixedBy.model && agent.modelId
          ? ModelModel.findById(agent.modelId)
          : null,
  ]);
  const connection = key?.organizationId === params.organizationId ? key : null;
  // A model set for the connection the caller picked is set for everyone
  // on that connection: it is not theirs to pick.
  const setForConnection =
    !fixedBy.connection && connection
      ? fixedBy.connectionModels?.[connection.id]
      : undefined;
  return {
    resolves,
    view: {
      connection: {
        id: connection?.id ?? null,
        name: connection ? await companyConnectionName(connection) : null,
        provider: connection?.provider ?? null,
        fixedBy: fixedBy.connection,
      },
      model: {
        id: model?.id ?? null,
        name: model ? model.description || model.modelId : null,
        fixedBy: fixedBy.model ?? setForConnection?.by ?? null,
      },
      // The models of a connection set for the caller, who may be unable
      // to list them, while its model is theirs to pick.
      ...(fixedBy.connection &&
        !fixedBy.model &&
        agent.llmApiKeyId && {
          models: await listConnectionModelsForRuntime({
            runtime: params.runtime,
            llmApiKeyId: agent.llmApiKeyId,
          }),
        }),
      usesOrganizationDefault: !!organizationDefault,
    },
  };
}

/**
 * The company API key of an agent saved before people could choose its
 * account, as its runs use it: the pair it stores where that pair is what
 * runs, set by the agent; else the organization's default, on the agent's
 * connection where it serves the default's provider, and each person's to
 * change. Nothing here is refused for being no company connection this
 * release would let an agent set: it ran before.
 */
async function savedCompanyAccount(params: {
  organizationId: string;
  agent: Pick<Agent, "llmApiKeyId" | "modelId">;
  llm: ConversationLlmSelection;
}): Promise<{
  resolves: boolean;
  view: AgentRuntimeAccount["companyAccount"];
}> {
  const { agent, llm } = params;
  const stored = agent.llmApiKeyId
    ? await LlmProviderApiKeyModel.findById(agent.llmApiKeyId)
    : null;
  const ownConnection =
    stored?.organizationId === params.organizationId &&
    stored.provider === llm.selectedProvider
      ? stored
      : null;
  const [key, model] = await Promise.all([
    ownConnection ??
      (llm.chatApiKeyId
        ? LlmProviderApiKeyModel.findById(llm.chatApiKeyId)
        : null),
    llm.modelId ? ModelModel.findById(llm.modelId) : null,
  ]);
  const connection = key?.organizationId === params.organizationId ? key : null;
  // The agent's own pair is what runs, not the default. Only that pair is
  // set by the agent: a connection stored alone sets nothing.
  const ownPair =
    !!ownConnection && !!agent.modelId && llm.modelId === agent.modelId;
  return {
    resolves: true,
    view: {
      connection: {
        id: connection?.id ?? null,
        name: connection ? await companyConnectionName(connection) : null,
        provider: connection?.provider ?? null,
        fixedBy: ownPair ? "agent" : null,
      },
      model: {
        id: model?.id ?? null,
        name: model ? model.description || model.modelId : null,
        fixedBy: ownPair ? "agent" : null,
      },
      usesOrganizationDefault: !ownPair,
    },
  };
}

/**
 * What a person stored as their account for their runs of an agent, as the
 * account reports it. Null when they chose nothing.
 */
export async function storedAgentRuntimeAccountChoice(params: {
  agentId: string;
  userId: string;
}): Promise<AgentRuntimeAccount["choice"]> {
  const row = await AgentRuntimeUserAccountModel.find(params);
  return row && toSelection(row);
}

function toSelection(row: AgentRuntimeUserAccount) {
  return {
    authentication: row.authentication,
    llmApiKeyId: row.llmApiKeyId,
    modelId: row.modelId,
    claudeModel: row.claudeModel,
  };
}

function requirePerson(userId: string) {
  if (actorFromUserId(userId).kind !== "user") {
    throw new ApiError(
      403,
      "Only a signed-in person can choose an account for their own runs.",
    );
  }
}

/** The account the agent's own settings give a run with no personal choice. */
export async function agentOwnAccount(params: {
  agent: Pick<Agent, "llmApiKeyId" | "modelId">;
  runtime: Pick<
    AgentRuntime,
    "image" | "command" | "inferenceProtocol" | "claudeCode"
  > & {
    accountLock?: ResolvedAgentRuntime["accountLock"];
  };
  organizationId: string;
  userId: string;
}): Promise<AgentRuntimeAccount["agentAccount"]> {
  return {
    authentication: await agentOwnAuthentication(params),
    llmApiKeyId: params.agent.llmApiKeyId,
    modelId: params.agent.modelId,
  };
}

/** The personal subscription the caller's runs of this agent can use. */
async function personalSubscription(
  params: Pick<AccountContext, "runtime" | "organizationId" | "userId">,
): Promise<AgentRuntimeAccount["subscription"]> {
  if (runtimeSupportsClaudeSubscription(params.runtime)) {
    const status = await claudeCodeAccountManager.status({
      runtime: params.runtime,
      userId: params.userId,
      inspectFlow: false,
    });
    return {
      kind: "claude",
      label: CLAUDE_SUBSCRIPTION_LABEL,
      connected: status.state === "connected",
      keyId: null,
    };
  }
  const kind = subscriptionKindForRuntimeCommand(params.runtime.command?.[0]);
  if (!kind) return null;
  const own = await findOwnSubscriptionKey({ ...params, kind });
  return {
    kind,
    label: SUBSCRIPTION_CREDENTIALS[kind].label,
    connected: !!own,
    keyId: own?.apiKey.id ?? null,
  };
}

const CLAUDE_SUBSCRIPTION_LABEL = "Claude subscription";
