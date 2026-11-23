import {
  AGENT_CATALOG_NAMES,
  agentRuntimeCanNameAccountKind,
  agentRuntimePermissionScope,
  buildAgentCatalogRuntime,
  type CompanyAccountWords,
  companyAccountWords,
  getAgentRuntimeModelCompatibility,
  getAgentRuntimeProviderCompatibility,
  PopularAgentIdSchema,
  resolveAgentRuntimeTemplate,
  runtimeSupportsClaudeSubscription,
  SUBSCRIPTION_CREDENTIALS,
  type SubscriptionCredentialKind,
  type SupportedProvider,
  subscriptionKindForRuntimeCommand,
  type TemplatedAgentRuntime,
  withAgentRuntimeDefaults,
} from "@archestra/shared";
import { actorFromUserId } from "@/auth/service-account-user-id";
import config from "@/config";
import {
  AgentRuntimeUserAccountModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
  TeamModel,
} from "@/models";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import type {
  AgentRuntimeAccountLock,
  LlmProviderApiKey,
  Model,
  ResolvedAgentRuntime,
} from "@/types";
import { ApiError, OWN_ACCOUNT_ONLY } from "@/types";
import type {
  RuntimeAccounts,
  RuntimeTemplateSettings,
} from "@/types/agent-runtime-template";

/**
 * The account a run binds: the agent's own, or the one the acting person
 * chose for their own runs of it.
 *
 * `subscriptionKind` names the person's own subscription the run must use
 * (null on the Claude subscription path, which the proxy swaps in itself).
 */
export type AgentRuntimeRunAccount =
  | {
      source: "agent";
      subscriptionKind: SubscriptionCredentialKind | null;
      /** Set under a `key` lock: the agent's own key, bound as it is. */
      keyId?: string;
    }
  /**
   * The person chose the company API key. Its connection, where the agent,
   * its runtime or the person names one, is bound as it is.
   */
  | { source: "choice"; authentication: "provider"; keyId?: string }
  | {
      source: "choice";
      authentication: "subscription";
      subscriptionKind: SubscriptionCredentialKind | null;
    };

/**
 * The company API key as one person's runs resolve it. Its connection and
 * its model are each set by the agent's runtime, else by the agent, else
 * chosen by the person: what a level sets holds for everyone below it.
 */
export type CompanyOption = {
  /**
   * Null when no level names a connection: the organization's default is
   * what resolves, as for an agent that stores none.
   */
  key: LlmProviderApiKey | null;
  /**
   * With a connection: its model, the organization's default when no level
   * names one and the connection serves it. Null when the person has one
   * to choose.
   */
  model: Model | null;
};

/** Which level sets each part of the company API key; null leaves it open. */
export type AccountFixedBy = {
  connection: "runtime" | "agent" | null;
  model: "runtime" | "agent" | null;
  /**
   * Where the connection is left to each person: the model set for a
   * connection they may pick, by connection id. It holds for everyone who
   * runs on that connection, as a model set with its connection does.
   */
  connectionModels?: Record<
    string,
    { modelId: string; by: "runtime" | "agent" }
  >;
};

/**
 * A person's stored choice, checked against what they may use today. A
 * `provider` choice is the company API key as it resolves for them, with
 * the connection and model they picked where those were left to them.
 */
export type PersonAccountChoice =
  | ({ authentication: "provider" } & CompanyOption)
  | {
      authentication: "subscription";
      model: Model | null;
      /** Their own Claude subscription's model; null for the agent's. */
      claudeModel: string | null;
    }
  /**
   * A choice that cannot run. With `companyOption`, because the company
   * option it names cannot: the agent's account to fix, not the person's
   * choice to change.
   */
  | { error: string; companyOption?: true }
  /** A choice the agent's account lock sets aside; runs use the agent's. */
  | { ignored: string };

type AgentAccountPair = {
  llmApiKeyId: string | null;
  modelId: string | null;
};

/**
 * Whether a stored choice picked a connection, and a model. Deleting one
 * empties its id, and only these tell that apart from a part never picked.
 * A choice being saved has none: its ids are what it picks.
 */
type ChosenParts = {
  llmApiKeyChosen?: boolean;
  modelChosen?: boolean;
};

type ChoiceRuntime = Pick<
  ResolvedAgentRuntime,
  "command" | "inferenceProtocol" | "claudeCode"
>;

/**
 * The stored choice of `userId` for their runs of `agentId`, re-checked: a
 * subscription must still suit the runtime, and a company API key must
 * still resolve to a connection and model the person may run on. Null for
 * no choice, or for anyone who is not a person.
 */
export async function loadPersonAccountChoice(params: {
  agentId: string | undefined;
  userId: string | null | undefined;
  /** The connection and model the agent and its runtime set. */
  agent: AgentAccountPair;
  fixedBy: AccountFixedBy;
  runtime: ChoiceRuntime;
  organizationId: string;
  lock: AgentRuntimeAccountLock | null;
  /** Why the company option cannot run, when its runtime's rule stops it. */
  companyProblem?: string | null;
}): Promise<PersonAccountChoice | null> {
  const { agentId, userId } = params;
  if (!agentId || !runsForPerson(userId)) return null;
  const row = await AgentRuntimeUserAccountModel.find({ agentId, userId });
  if (!row) return null;
  // Under a `key` lock a choice of the company API key says what the lock
  // already does, unless it names a part left to each person, or named one
  // that was deleted since. The lock decides the run, so a broken key is
  // reported as the agent's to fix, not as a choice the person could change.
  if (
    params.lock === "key" &&
    row.authentication === "provider" &&
    !(!params.fixedBy.connection && (row.llmApiKeyId || row.llmApiKeyChosen)) &&
    !(!params.fixedBy.model && (row.modelId || row.modelChosen))
  ) {
    return null;
  }
  if (!accountLockAllows({ lock: params.lock, kind: row.authentication })) {
    // A lock always exists here: no lock allows every kind.
    const lock = params.lock as AgentRuntimeAccountLock;
    return {
      ignored: `This agent is locked to ${accountLockLabel(lock, companyAccountWords(params.runtime.command?.[0]))}, so your own choice is not used.`,
    };
  }
  if (row.authentication === "provider" && params.companyProblem) {
    return { error: params.companyProblem, companyOption: true };
  }
  const checked = await validateAccountChoice({
    runtime: params.runtime,
    organizationId: params.organizationId,
    userId,
    agent: params.agent,
    fixedBy: params.fixedBy,
    choice: row,
  });
  if (!("problem" in checked)) return checked.choice;
  // Under a `key` lock, what the agent sets is not a choice to make again.
  if (checked.problem.fixed && params.lock === "key") return null;
  return choiceError(checked.problem.stale);
}

/** Why a choice cannot be saved (`reason`) or no longer runs (`stale`). */
export type AccountChoiceProblem = {
  status: 400 | 403 | 409;
  reason: string;
  stale: string;
  /**
   * The problem is in what the agent or its runtime sets, not in what the
   * person picked.
   */
  fixed?: true;
};

/**
 * The one check of a person's account choice, applied when they save it and
 * again at every run: a subscription choice must suit the runtime and its
 * subscription; a company-key choice must resolve to a connection and model
 * that run here (`resolveCompanyOption`).
 */
export async function validateAccountChoice(params: {
  runtime: ChoiceRuntime;
  organizationId: string;
  /** Whose choice it is: a connection they pick must be theirs to use. */
  userId: string;
  /** The connection and model the agent and its runtime set. */
  agent: AgentAccountPair;
  fixedBy: AccountFixedBy;
  choice: {
    authentication: "provider" | "subscription";
    llmApiKeyId: string | null;
    modelId: string | null;
    claudeModel: string | null;
  } & ChosenParts;
  /** The choice is being saved, not read back for a run. */
  saving?: boolean;
}): Promise<
  | {
      choice: Extract<PersonAccountChoice, { authentication: string }>;
    }
  | { problem: AccountChoiceProblem }
> {
  const { choice, runtime } = params;
  const words = companyAccountWords(runtime.command?.[0]);
  const problem = (
    status: AccountChoiceProblem["status"],
    reason: string,
    stale: string = reason,
  ) => ({ problem: { status, reason, stale } });

  if (choice.authentication === "subscription") {
    if (choice.llmApiKeyId) {
      return problem(
        400,
        `A ${words.connection} goes only with ${words.a}. Leave it empty.`,
      );
    }
    if (runtimeSupportsClaudeSubscription(runtime)) {
      // Claude subscription models are aliases Claude Code names, not
      // catalog rows: they travel as `claudeModel`.
      if (choice.modelId) {
        return problem(
          400,
          "A Claude subscription names its model as Claude Code does. Leave the catalog model empty.",
        );
      }
      if (runtime.inferenceProtocol !== "anthropic") {
        return problem(409, CLAUDE_SUBSCRIPTION_PROTOCOL_MESSAGE);
      }
      return {
        choice: {
          authentication: "subscription",
          model: null,
          claudeModel: choice.claudeModel,
        },
      };
    }
    // Which subscription a person may choose follows the runtime, as the
    // account they are offered does: a model of another vendor's
    // subscription, or any subscription on a runtime with none, is refused.
    const kind = subscriptionKindForRuntimeCommand(runtime.command?.[0]);
    if (!kind) {
      return problem(
        400,
        "This agent's runtime cannot run on a personal subscription. Choose the company API key instead.",
        "Its runtime does not run on personal subscriptions.",
      );
    }
    if (choice.claudeModel) return problem(400, CLAUDE_MODEL_MISPLACED_MESSAGE);
    // A model they picked that was deleted since leaves no model to run,
    // not the subscription's default.
    if (!choice.modelId && !choice.modelChosen) {
      return {
        choice: {
          authentication: "subscription",
          model: null,
          claudeModel: null,
        },
      };
    }
    const model = choice.modelId
      ? await ModelModel.findById(choice.modelId)
      : null;
    if (!model) {
      return problem(
        400,
        "The selected model no longer exists.",
        "Its model no longer exists.",
      );
    }
    if (SUBSCRIPTION_CREDENTIALS[kind].provider !== model.provider) {
      return problem(
        400,
        `${model.modelId} cannot run on a personal subscription here. Choose one of your subscription's models.`,
        `${model.modelId} cannot run on a personal subscription here.`,
      );
    }
    const incompatible = modelIncompatibility({ runtime, model });
    if (incompatible) return problem(409, incompatible);
    return {
      choice: { authentication: "subscription", model, claudeModel: null },
    };
  }

  if (choice.claudeModel) return problem(400, CLAUDE_MODEL_MISPLACED_MESSAGE);
  const company = await resolveCompanyOption({
    runtime,
    organizationId: params.organizationId,
    agent: params.agent,
    fixedBy: params.fixedBy,
    chosen: {
      userId: params.userId,
      llmApiKeyId: choice.llmApiKeyId,
      modelId: choice.modelId,
      llmApiKeyChosen: choice.llmApiKeyChosen,
      modelChosen: choice.modelChosen,
    },
    saving: params.saving,
  });
  if ("problem" in company) return company;
  return { choice: { authentication: "provider", ...company } };
}

/**
 * The company API key as it resolves for one run. The connection is the one
 * the agent's runtime sets, else the agent's, else the one the person
 * chose; the model likewise, then the organization's default when the
 * connection serves it. With no connection at any level, the organization's
 * default is what resolves, as for an agent that stores none: the caller
 * resolves it.
 *
 * What a level sets holds for everyone below it, whoever may read it: a
 * person's permissions count only for a connection they pick themselves,
 * which must be one they could give an agent of their own, must hold an API
 * key rather than a personal subscription, and must serve the runtime. A
 * model must be one of the connection's and run on the runtime.
 *
 * A stored choice is set aside where a level above now sets that part, as
 * an account lock sets one aside: the connection the person stored is not
 * read under a connection set above, and a model they stored that is none
 * of that connection's is no pick at all, so the model is open again. A
 * choice with nothing set above it that no longer works is a problem, never
 * a move to another connection or model: its connection or its model was
 * deleted, its connection is no longer the person's to use, or its model is
 * no longer one of the models of the connection they picked.
 */
export async function resolveCompanyOption(params: {
  runtime: ChoiceRuntime;
  organizationId: string;
  /** The connection and model the agent and its runtime set. */
  agent: AgentAccountPair;
  fixedBy: AccountFixedBy;
  /** What the person picked for the parts left to them. */
  chosen?:
    | ({
        userId: string;
        llmApiKeyId: string | null;
        modelId: string | null;
      } & ChosenParts)
    | null;
  /** A choice being saved may not name a part a level above sets. */
  saving?: boolean;
}): Promise<CompanyOption | { problem: AccountChoiceProblem }> {
  const { runtime, agent, fixedBy } = params;
  const chosen = params.chosen ?? null;
  const words = companyAccountWords(runtime.command?.[0]);
  // What a person can do where the company option cannot run: their own
  // subscription is a way out only on a runtime that has one.
  const ownSubscription = hasPersonalSubscription(runtime);
  // What the agent or its runtime sets and that no longer works: the people
  // who can fix it are the agent's editors, or the runtime's.
  const gone = (
    level: "agent" | "runtime" | null,
    part: "connection" | "model",
  ) =>
    level === "runtime"
      ? fixed(...runtimeAccountGone({ words, part }))
      : fixed(...companyAccountGone({ words, ownSubscription }));
  const own = (
    status: AccountChoiceProblem["status"],
    reason: string,
    stale: string = reason,
  ) => ({ problem: { status, reason, stale } });
  const fixed = (reason: string, stale: string = reason) => ({
    problem: { status: 409 as const, reason, stale, fixed: true as const },
  });
  const modelDeleted = () =>
    own(
      400,
      "The selected model does not exist.",
      "The model you chose no longer exists.",
    );

  if (params.saving && chosen?.llmApiKeyId && fixedBy.connection) {
    return own(409, fixedPartMessage("connection", fixedBy.connection, words));
  }
  if (params.saving && chosen?.modelId && fixedBy.model) {
    return own(409, fixedPartMessage("model", fixedBy.model, words));
  }
  const llmApiKeyId = fixedBy.connection
    ? agent.llmApiKeyId
    : (chosen?.llmApiKeyId ?? null);
  // A model set for the connection the person picked holds for everyone on
  // that connection.
  const setForConnection =
    !fixedBy.connection && llmApiKeyId
      ? fixedBy.connectionModels?.[llmApiKeyId]
      : undefined;
  const modelFixedBy = fixedBy.model ?? setForConnection?.by ?? null;
  if (params.saving && chosen?.modelId && setForConnection) {
    return own(409, fixedPartMessage("model", setForConnection.by, words));
  }
  const modelId = fixedBy.model
    ? agent.modelId
    : (setForConnection?.modelId ?? chosen?.modelId ?? null);
  // A part a level above sets and that no longer works is never replaced
  // by the person's own, nor by the organization's default.
  if (fixedBy.connection && !llmApiKeyId) {
    return gone(fixedBy.connection, "connection");
  }
  if (fixedBy.model && !modelId) return gone(fixedBy.model, "model");
  if (!llmApiKeyId) {
    if (!modelId) {
      // Nothing is left of what the person picked: deleting a connection or
      // a model empties its id. The run does not take the organization's
      // default instead.
      if (chosen?.llmApiKeyChosen) {
        return own(
          400,
          `The selected ${words.connection} does not exist.`,
          `The ${words.connection} you chose no longer exists.`,
        );
      }
      if (chosen?.modelChosen) return modelDeleted();
      return { key: null, model: null };
    }
    // Only a person's model stands without a connection: the one they
    // picked it with was deleted, or the agent no longer sets its own.
    return own(
      400,
      `Choose ${words.aConnection} before its model.`,
      `The model you chose has no ${words.connection} any more.`,
    );
  }

  const connection = await checkCompanyConnection({
    runtime,
    organizationId: params.organizationId,
    llmApiKeyId,
    modelId: null,
  });
  if ("problem" in connection) {
    if (connection.problem === "incompatible") {
      return fixedBy.connection
        ? fixed(connection.message)
        : own(409, connection.message);
    }
    if (connection.problem === "personal") {
      return fixedBy.connection
        ? fixed(
            `${
              words.plan
                ? "This agent's own plan is a personal subscription, not the company's enterprise plan."
                : "This agent's own key is a personal subscription, not a company API key."
            } ${ownSubscription ? USE_OWN_SUBSCRIPTION : "Someone who can edit the agent must choose another."}`,
            words.plan
              ? "The agent's own plan is a personal subscription, not the company's enterprise plan."
              : "The agent's own key is a personal subscription, not a company API key.",
          )
        : own(
            400,
            words.plan
              ? `That plan is a personal subscription, not an enterprise plan. ${ownSubscription ? "Choose your personal subscription instead, or an enterprise plan." : "Choose an enterprise plan."}`
              : `That connection is a personal subscription, not an API key. ${ownSubscription ? "Choose your personal subscription instead, or a connection that holds an API key." : "Choose a connection that holds an API key."}`,
            words.plan
              ? "The plan you chose is a personal subscription, not an enterprise plan."
              : "The connection you chose is a personal subscription, not an API key.",
          );
    }
    return fixedBy.connection
      ? gone(fixedBy.connection, "connection")
      : own(
          400,
          `The selected ${words.connection} does not exist.`,
          `The ${words.connection} you chose no longer exists.`,
        );
  }
  if (!fixedBy.connection && chosen) {
    const { keys } = await LlmProviderApiKeyModel.findUsableKeys({
      organizationId: params.organizationId,
      userId: chosen.userId,
    });
    if (!keys.some(({ id }) => id === llmApiKeyId)) {
      return own(
        403,
        `You cannot use this ${words.connection} yourself. Choose one that is shared with you.`,
        `You can no longer use the ${words.connection} you chose.`,
      );
    }
  }
  const withOpenModel = async () => ({
    key: connection.key,
    model: await organizationDefaultModelOn({
      runtime,
      organizationId: params.organizationId,
      llmApiKeyId,
    }),
  });
  // A model the person stored with another connection of their own, picked
  // before a level above set this one, is no pick for this connection:
  // nothing of theirs broke, and the model is theirs to pick, as if they had
  // not yet. One they picked for this connection that it no longer serves,
  // or that was deleted, is a choice that stopped working, never a quiet
  // move to another model.
  const modelPickedElsewhere =
    !!fixedBy.connection &&
    !params.saving &&
    (chosen?.llmApiKeyId
      ? chosen.llmApiKeyId !== llmApiKeyId
      : !!chosen?.llmApiKeyChosen);
  if (!modelId) {
    if (chosen?.modelChosen && !modelPickedElsewhere) return modelDeleted();
    return withOpenModel();
  }
  const pair = await checkCompanyConnection({
    runtime,
    organizationId: params.organizationId,
    llmApiKeyId,
    modelId,
  });
  if (!("problem" in pair)) return { key: pair.key, model: pair.model };
  if (pair.problem === "incompatible") {
    return modelFixedBy ? fixed(pair.message) : own(409, pair.message);
  }
  if (modelFixedBy) return gone(modelFixedBy, "model");
  if (modelPickedElsewhere) return withOpenModel();
  return own(
    400,
    `The selected model is not one of the ${words.connection}'s models. Choose one of them.`,
    `The model you chose is no longer one of its ${words.connection}'s models.`,
  );
}

/**
 * A company connection's name for someone who may not read it. An enterprise
 * plan is named as every picker names it, after the GitHub organization it
 * is billed to: "GitHub Copilot Acme Inc". Its stored name says nothing of
 * which plan it is where an organization connected several.
 */
export async function companyConnectionName(key: {
  id: string;
  name: string;
  provider: SupportedProvider;
}): Promise<string> {
  if (key.provider !== "github-copilot") return key.name;
  const source = (
    await LlmProviderApiKeyModel.findCopilotCredentialSources([key.id])
  ).get(key.id);
  const organization =
    source?.kind === "organization"
      ? source.organizationName || source.organization
      : null;
  return organization ? `GitHub Copilot ${organization}` : key.name;
}

/**
 * The checks a company connection passes before agents of a runtime run on
 * it, wherever it is named (an agent's own key behind a person's company-key
 * choice, or the connection a runtime's settings fix): it is in the
 * organization, is not a personal credential, serves the runtime's protocol,
 * and, when a model is named, is linked to that model, which runs on the
 * runtime. With no model, the connection alone is checked.
 */
export async function checkCompanyConnection(params: {
  runtime: ChoiceRuntime;
  organizationId: string;
  llmApiKeyId: string;
  modelId: string | null;
}): Promise<
  | { key: LlmProviderApiKey; model: Model | null }
  /** The connection is gone, is someone's own, or does not serve the model. */
  | { problem: "missing" | "personal" | "model" }
  /** The runtime cannot run the connection's provider or the model. */
  | { problem: "incompatible"; message: string }
> {
  const { runtime } = params;
  const key = await LlmProviderApiKeyModel.findByIdWithSubscriptionInfo(
    params.llmApiKeyId,
  );
  if (!key || key.organizationId !== params.organizationId) {
    return { problem: "missing" };
  }
  if (await LlmProviderApiKeyModel.isPersonalCredential(key)) {
    return { problem: "personal" };
  }
  const providerCompatibility = getAgentRuntimeProviderCompatibility({
    inferenceProtocol: runtime.inferenceProtocol,
    runtimeCommand: runtime.command,
    provider: key.provider,
  });
  if (!providerCompatibility.compatible) {
    return { problem: "incompatible", message: providerCompatibility.message };
  }
  // The GitHub Copilot CLI has no provider API key: its company account is
  // an enterprise plan the organization connected.
  if (
    companyAccountWords(runtime.command?.[0]).plan &&
    key.provider !== COPILOT_PLAN_PROVIDER
  ) {
    return { problem: "incompatible", message: NOT_AN_ENTERPRISE_PLAN };
  }
  if (!params.modelId) return { key, model: null };
  const [model, linked] = await Promise.all([
    ModelModel.findById(params.modelId),
    LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds([key.id]),
  ]);
  if (!model || !linked.some((link) => link.model.id === model.id)) {
    return { problem: "model" };
  }
  const incompatible = modelIncompatibility({ runtime, model });
  if (incompatible) return { problem: "incompatible", message: incompatible };
  return { key, model };
}

/**
 * The person's own subscription key a run must bind, or null when the run
 * needs none. Refuses a run that needs one when the person has not connected
 * it: the maintained Codex runtime, and anyone who chose their subscription,
 * never fall back to a company key.
 */
export async function requirePersonalSubscriptionKey(params: {
  organizationId: string;
  userId: string | null;
  kind: SubscriptionCredentialKind | null;
  /**
   * Why the run needs it: the person chose their subscription, the agent is
   * locked to personal subscriptions, or the maintained runtime needs one.
   */
  reason: "choice" | "lock" | "maintained";
}): Promise<Awaited<ReturnType<typeof findOwnSubscriptionKey>>> {
  if (!params.kind) return null;
  const key = params.userId
    ? await findOwnSubscriptionKey({
        organizationId: params.organizationId,
        userId: params.userId,
        kind: params.kind,
      })
    : null;
  if (!key) {
    throw new ApiError(
      409,
      personalSubscriptionRequiredMessage({
        kind: params.kind,
        reason: params.reason,
      }),
    );
  }
  return key;
}

/**
 * Why a run on `account` needs the person's own subscription: they chose it,
 * the agent is locked to personal subscriptions, or the maintained runtime
 * runs on one.
 */
export function personalSubscriptionReason(params: {
  account: AgentRuntimeRunAccount;
  accountLock: AgentRuntimeAccountLock | null;
}): "choice" | "lock" | "maintained" {
  return params.account.source === "choice"
    ? "choice"
    : params.accountLock === "subscription"
      ? "lock"
      : "maintained";
}

/**
 * The subscription a run on `account` needs and the person has not
 * connected, with what the run is refused with: the check of binding a
 * run's key, made ahead of it by the preflight. Null when the run needs none
 * or finds theirs.
 */
export async function missingPersonalSubscription(params: {
  account: AgentRuntimeRunAccount;
  accountLock: AgentRuntimeAccountLock | null;
  organizationId: string;
  userId: string;
}): Promise<{ kind: SubscriptionCredentialKind; message: string } | null> {
  const { account } = params;
  const kind = "subscriptionKind" in account ? account.subscriptionKind : null;
  if (!kind) return null;
  const own = await findOwnSubscriptionKey({
    organizationId: params.organizationId,
    userId: params.userId,
    kind,
  });
  if (own) return null;
  return {
    kind,
    message: personalSubscriptionRequiredMessage({
      kind,
      reason: personalSubscriptionReason(params),
    }),
  };
}

/**
 * Whether a person may choose an account of `kind` under `lock`. A choice of
 * the company API key is what a `key` lock gives everyone anyway.
 */
export function accountLockAllows(params: {
  lock: AgentRuntimeAccountLock | null | undefined;
  kind: "subscription" | "provider";
}): boolean {
  if (!params.lock) return true;
  return params.lock === "key"
    ? params.kind === "provider"
    : params.kind === "subscription";
}

/** What an account lock holds every run to, as a message names it. */
export function accountLockLabel(
  lock: AgentRuntimeAccountLock,
  words: CompanyAccountWords,
): string {
  return lock === "subscription" ? "each person's own subscription" : words.a;
}

/**
 * Refuse a run whose bound account breaks the agent's account lock, whatever
 * path chose it: a provider fallback to another key, or a key swapped for
 * one that serves the model.
 */
export async function assertRunHonoursAccountLock(params: {
  lock: AgentRuntimeAccountLock | null | undefined;
  /**
   * The connection the company API key resolves to for this run: the one
   * the agent, its runtime or the person names. Null when none does and the
   * organization's default applies.
   */
  companyConnectionId: string | null;
  /** The run is on the Claude subscription path (no key is bound). */
  claudeSubscription: boolean;
  boundKeyId: string | null;
  /** The provider of the model the run selected. */
  provider: SupportedProvider;
  /** The runtime's launch command: it decides what the messages call a key. */
  runtimeCommand: string | null | undefined;
}): Promise<void> {
  const { lock } = params;
  if (!lock) return;
  const words = companyAccountWords(params.runtimeCommand);
  const keyWord = words.plan ? "plan" : "key";
  const key =
    params.boundKeyId && !params.claudeSubscription
      ? await LlmProviderApiKeyModel.findByIdWithSubscriptionInfo(
          params.boundKeyId,
        )
      : null;
  const personal =
    params.claudeSubscription ||
    (!!key && (await LlmProviderApiKeyModel.isPersonalCredential(key)));
  const fix =
    "Someone who can configure its runtime must change its account or its lock.";
  if (lock === "subscription" && !personal) {
    throw new ApiError(
      409,
      `This agent is locked to each person's own subscription, but this run would use ${words.a}. ${fix}`,
    );
  }
  if (lock === "key") {
    if (
      !key ||
      (params.companyConnectionId && key.id !== params.companyConnectionId)
    ) {
      throw new ApiError(
        409,
        `This agent is locked to ${words.a}, but this run would use another ${keyWord} than the one set for it, or none. ${fix}`,
      );
    }
    // The key's value may since have been replaced by someone's own
    // subscription credential, which is never bound for other people.
    if (personal) {
      throw new ApiError(
        409,
        `This agent is locked to ${words.a}, but this run would use a personal subscription. ${fix}`,
      );
    }
    if (key.provider !== params.provider) {
      throw new ApiError(
        409,
        `This agent is locked to ${words.a}, but this run selected a ${params.provider} model for its ${key.provider} ${keyWord}. ${fix}`,
      );
    }
  }
}

/**
 * A runtime with the Claude account its runs resolve to: the one the account
 * rule of its runtime names, where the agent stores none of its own. What
 * reads or starts a person's Claude sign-in for an agent is given this
 * runtime, as resolution is, so both answer for the same account.
 */
export function withResolvedClaudeAccount<
  Runtime extends Pick<ResolvedAgentRuntime, "claudeCode">,
>(
  runtime: Runtime,
  resolved: Pick<ResolvedAgentRuntime, "claudeCode">,
): Runtime {
  return resolved.claudeCode
    ? { ...runtime, claudeCode: resolved.claudeCode }
    : runtime;
}

/**
 * What a run on the company API key is refused with while a part of it is
 * nobody's yet. A person picks it on the agent's page. A run with no person
 * behind it, a schedule or a service account, has nobody to pick: the
 * agent's editors set it.
 */
export function chooseConnectionMessage(
  words: CompanyAccountWords,
  forPerson = true,
): string {
  return forPerson
    ? `Choose ${words.aConnection} on the agent's page to run this agent.`
    : `This agent leaves its ${words.connection} to each person, and this run has no person behind it. Someone who can edit the agent must set ${words.aConnection}.`;
}
export function chooseModelMessage(forPerson = true): string {
  return forPerson
    ? "Choose a model on the agent's page to run this agent."
    : "This agent leaves its model to each person, and this run has no person behind it. Someone who can edit the agent must set a model.";
}

/**
 * Whether a run acts for a signed-in person. Only a person has a choice of
 * their own, and a page to pick on.
 */
export function runsForPerson(
  userId: string | null | undefined,
): userId is string {
  return (
    !!userId && userId !== "system" && actorFromUserId(userId).kind === "user"
  );
}

/** The message a run start and the account routes give a stale choice. */
export function choiceError(reason: string): { error: string } {
  return {
    error: `Your own account for this agent no longer works. ${reason} Choose your account again.`,
  };
}

export const CLAUDE_SUBSCRIPTION_PROTOCOL_MESSAGE =
  "A Claude subscription needs an image that uses the Anthropic API inference protocol.";

/**
 * The person's own key for a subscription. A marked credential is found by its
 * marker; a provider that is per-person anyway (no marker) is any of their own
 * keys of it that is not a shared GitHub App key.
 */
export async function findOwnSubscriptionKey(params: {
  organizationId: string;
  userId: string;
  kind: SubscriptionCredentialKind;
}): Promise<{
  apiKey: LlmProviderApiKey;
  /** The decrypted credential, for a marked subscription only. */
  apiKeyValue: string | null;
} | null> {
  if (SUBSCRIPTION_CREDENTIALS[params.kind].marker !== null) {
    return LlmProviderApiKeyModel.findPersonalSubscriptionKey(params);
  }
  const keys = await LlmProviderApiKeyModel.getAvailableKeysForUser(
    params.organizationId,
    params.userId,
    await TeamModel.getUserTeamIds(params.userId),
    SUBSCRIPTION_CREDENTIALS[params.kind].provider,
    { includeSubscriptionInfo: true },
  );
  const own = keys
    .filter((key) => key.userId === params.userId && !key.isGithubAppKey)
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  const apiKey = own[0]
    ? await LlmProviderApiKeyModel.findById(own[0].id)
    : null;
  return apiKey ? { apiKey, apiKeyValue: null } : null;
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

/**
 * The inputs of account resolution: what the agent stores about its account
 * (its lock, its own Claude account, its connection and model), as far as a
 * run's account is resolved from them.
 */
export type AccountInputs<Runtime extends RuleRuntime = RuleRuntime> = {
  runtime: Runtime;
  /**
   * The connection and model of the company API key as the agent and its
   * runtime set them. A part neither sets is null: each person chooses it.
   */
  agent: AgentAccountPair;
  /**
   * The connection and model the agent itself stores. What its runtime
   * fixes is the company API key's: a run on a personal subscription keeps
   * the agent's own, and the agent's own way is judged on them.
   */
  own: AgentAccountPair;
  /** Which of the two sets each part. */
  fixedBy: AccountFixedBy;
  /**
   * Why the company option cannot run, when the runtime fixes a connection
   * the agent's own model is not a model of. Null when it can.
   */
  companyProblem: string | null;
};

/**
 * The inputs of account resolution as the agent alone gives them, with no
 * account rule of its runtime: its connection, and its model with it. A
 * model sets nothing without its connection, so one whose connection was
 * deleted is left to each person, like the connection.
 */
export function ownAccountInputs<Runtime extends RuleRuntime>(params: {
  runtime: Runtime;
  agent: AgentAccountPair;
}): AccountInputs<Runtime> {
  const { llmApiKeyId } = params.agent;
  const modelId = llmApiKeyId ? params.agent.modelId : null;
  // A connection an agent saved before people could choose its account
  // stores without a model sets nothing of the company API key: its runs
  // took the organization's default, on that connection only where it serves
  // the default's provider. It stays the agent's own, which a run binds
  // first.
  const setsConnection =
    !!llmApiKeyId &&
    (!!modelId || params.runtime.accountLock !== OWN_ACCOUNT_ONLY);
  const connectionModels = llmApiKeyId
    ? []
    : Object.entries(params.runtime.connectionModels ?? {});
  return {
    runtime: params.runtime,
    agent: setsConnection
      ? { llmApiKeyId, modelId }
      : { llmApiKeyId: null, modelId: null },
    own: { llmApiKeyId, modelId },
    fixedBy: {
      connection: setsConnection ? "agent" : null,
      model: modelId ? "agent" : null,
      ...(connectionModels.length > 0 && {
        connectionModels: Object.fromEntries(
          connectionModels.map(([id, model]) => [
            id,
            { modelId: model, by: "agent" as const },
          ]),
        ),
      }),
    },
    companyProblem: null,
  };
}

/**
 * The inputs of account resolution with the account rule of the agent's
 * runtime laid over what the agent stores. A rule (`accounts` in the
 * runtime's settings) applies at once to every agent on the runtime, for
 * every person, and changes nothing the agent stores, so clearing it gives
 * each agent its own settings back:
 *
 * - a named kind is the agent's account lock, and on a Claude runtime its
 *   own Claude account follows the kind;
 * - a fixed connection is the company option's connection, and a fixed model
 *   its model. A model pool or an auto router the agent stores plays no
 *   part, and the agent's own connection is not read for the company
 *   option. It stays in `own`: a run on a personal subscription keeps the
 *   agent's own connection and model, and the fixed ones move no agent
 *   from subscriptions to the company option;
 * - with the connection fixed and no model, the agent's own model stays when
 *   it is one of that connection's and runs on the runtime. An agent that
 *   stores none leaves the model to each person.
 *
 * What neither the rule nor the agent sets is null in `agent`, and
 * `fixedBy` says which of them sets each part: the same rule at both
 * levels, and again for the person below them (`resolveCompanyOption`).
 *
 * It fails closed. When the fixed connection or model no longer works, or
 * the agent's own model is none of the connection's, the company option
 * cannot run and `companyProblem` says why: nothing falls back to what the
 * agent stores. A run on a personal subscription needs no company option
 * and is not affected.
 *
 * A Claude account a runtime's settings store without a rule is not a rule:
 * it only starts new agents, and is laid over nothing here.
 *
 * This is the one place the rule is applied. Resolution calls it where its
 * inputs enter; nothing else reads a rule to decide a run's account.
 */
export async function withRuntimeAccountRule<
  Runtime extends RuleRuntime,
>(params: {
  organizationId: string;
  runtime: Runtime;
  agent: AgentAccountPair;
}): Promise<AccountInputs<Runtime>> {
  const target = agentRuntimeFor({
    runtime: params.runtime,
    settings: await AgentRuntimeTemplateModel.getSettings(
      params.organizationId,
    ),
  });
  if (!target?.accounts) return ownAccountInputs(params);
  const kind = runtimeAccountKind(target);
  const claudeAccount = kind ? claudeAccountNamedByRuntime(target) : null;
  const runtime: Runtime = kind
    ? {
        ...params.runtime,
        accountLock: kind,
        ...(claudeAccount && {
          claudeCode: {
            ...(params.runtime.claudeCode ?? target.runtime.claudeCode),
            authentication: claudeAccount,
          },
        }),
      }
    : params.runtime;
  const fixed = await fixedRuntimeAccount({ ...params, target });
  if (!fixed) {
    return withRuntimeConnectionModels({
      inputs: ownAccountInputs({ runtime, agent: params.agent }),
      models: kind === "subscription" ? {} : target.accounts.connectionModels,
    });
  }
  const { own } = ownAccountInputs(params);
  const someoneMustChoose = `Someone who can configure the runtime must choose another.`;
  if (fixed.keyMissing) {
    return {
      runtime,
      agent: { llmApiKeyId: null, modelId: null },
      own,
      fixedBy: {
        connection: "runtime",
        model: fixed.modelId ? "runtime" : null,
      },
      companyProblem: `The ${companyAccountWords(params.runtime.command?.[0]).connection} the ${target.name} runtime runs its agents on no longer works. ${someoneMustChoose}`,
    };
  }
  if (fixed.modelId) {
    return {
      runtime,
      agent: {
        llmApiKeyId: fixed.llmApiKeyId,
        modelId: fixed.modelMissing ? null : fixed.modelId,
      },
      own,
      fixedBy: { connection: "runtime", model: "runtime" },
      companyProblem: fixed.modelMissing
        ? `The model the ${target.name} runtime runs its agents on no longer works. ${someoneMustChoose}`
        : null,
    };
  }
  // The runtime leaves the model open: the agent's own, else each person's.
  if (!params.agent.modelId) {
    return {
      runtime,
      agent: { llmApiKeyId: fixed.llmApiKeyId, modelId: null },
      own,
      fixedBy: { connection: "runtime", model: null },
      companyProblem: null,
    };
  }
  const ownModel = await checkCompanyConnection({
    runtime: target.runtime,
    organizationId: params.organizationId,
    llmApiKeyId: fixed.llmApiKeyId,
    modelId: params.agent.modelId,
  });
  const keeps = !("problem" in ownModel);
  return {
    runtime,
    agent: {
      llmApiKeyId: fixed.llmApiKeyId,
      modelId: keeps ? params.agent.modelId : null,
    },
    own,
    fixedBy: { connection: "runtime", model: "agent" },
    companyProblem: keeps
      ? null
      : // The agent sets this model, so no runner can pick another, and the
        // connection is not named: the setup check reads to anyone who may
        // see the agent.
        `This agent's model is not available through the ${companyAccountWords(params.runtime.command?.[0]).connection} the ${target.name} runtime runs its agents on. Someone who can edit the agent must choose another model.`,
  };
}

/** One of the organization's Agent Runtimes, as its settings resolve. */
export type AgentRuntimeTarget = {
  id: string;
  scope: string;
  name: string;
  runtime: TemplatedAgentRuntime;
  /** A custom runtime's image is its own; a maintained one follows the catalog. */
  setsImage: boolean;
  /**
   * The Claude account the runtime's settings store beside any rule: a
   * maintained runtime's stored one, a custom runtime's own. It restricts
   * nothing and is written on no agent: it is only the Claude account a new
   * agent starts on when it names none. Null when none is stored.
   */
  claudeAccount: "provider" | "subscription" | null;
  /**
   * The account rule as stored. Read it through `runtimeAccountKind` and
   * `fixedRuntimeAccount`, which hold it to what the runtime can do and to
   * what still exists.
   */
  accounts: RuntimeAccounts | undefined;
};

/**
 * The account kind a runtime names for its agents: the kind in its account
 * rule, which is every one of its agents' account lock while the rule
 * stands. Null when it leaves the kind to each agent, so that whoever builds
 * the agent chooses it: the rule names none, or the runtime's agents have
 * one kind only. Nothing else in a runtime's settings names a kind: a Claude
 * account stored there without a rule is only a new agent's starting value.
 */
export function runtimeAccountKind(
  target: AgentRuntimeTarget | null,
): AgentRuntimeAccountLock | null {
  return target && agentRuntimeCanNameAccountKind(target.runtime)
    ? (target.accounts?.kind ?? null)
    : null;
}

/**
 * The Claude account of the kind a Claude runtime's account rule names,
 * which its agents' own Claude account follows. Null on a runtime that is
 * not Claude's, or whose rule names no kind.
 */
export function claudeAccountNamedByRuntime(
  target: AgentRuntimeTarget | null,
): "provider" | "subscription" | null {
  if (!target || !runtimeSupportsClaudeSubscription(target.runtime)) {
    return null;
  }
  const kind = runtimeAccountKind(target);
  return kind ? (kind === "subscription" ? "subscription" : "provider") : null;
}

/**
 * The connection, and the model when one is set, a runtime's account rule
 * fixes for its agents, with whether each still works: `keyMissing` when the
 * connection was deleted, became someone's own or no longer serves the
 * runtime, `modelMissing` when the model was deleted, is no longer one of
 * the connection's or no longer runs on the runtime. Null when the rule
 * fixes none, or names subscriptions only.
 */
export async function fixedRuntimeAccount(params: {
  target: AgentRuntimeTarget | null;
  organizationId: string;
}): Promise<{
  llmApiKeyId: string;
  /** Null when the connection was deleted. */
  keyName: string | null;
  keyProvider: SupportedProvider | null;
  keyMissing: boolean;
  /** The model the rule fixes, as stored. */
  modelId: string | null;
  /** Null when no model is fixed, or it was deleted. */
  modelName: string | null;
  modelMissing: boolean;
} | null> {
  const { target } = params;
  const llmApiKeyId = target?.accounts?.llmApiKeyId;
  if (!target || !llmApiKeyId || runtimeAccountKind(target) === "subscription")
    return null;
  const modelId = target.accounts?.modelId ?? null;
  const [key, model, connection] = await Promise.all([
    LlmProviderApiKeyModel.findById(llmApiKeyId),
    modelId ? ModelModel.findById(modelId) : null,
    checkCompanyConnection({
      runtime: target.runtime,
      organizationId: params.organizationId,
      llmApiKeyId,
      modelId: null,
    }),
  ]);
  const keyMissing = "problem" in connection;
  const pair =
    keyMissing || !modelId
      ? null
      : await checkCompanyConnection({
          runtime: target.runtime,
          organizationId: params.organizationId,
          llmApiKeyId,
          modelId,
        });
  return {
    llmApiKeyId,
    keyName:
      key?.organizationId === params.organizationId
        ? await companyConnectionName(key)
        : null,
    keyProvider:
      key?.organizationId === params.organizationId ? key.provider : null,
    keyMissing,
    modelId,
    modelName: model ? model.description || model.modelId : null,
    modelMissing: !!pair && "problem" in pair,
  };
}

/**
 * A connection's models that run on a runtime, for whoever picks the model
 * of a connection set for them, which they may be unable to list.
 */
export async function listConnectionModelsForRuntime(params: {
  runtime: Pick<TemplatedAgentRuntime, "command" | "inferenceProtocol">;
  llmApiKeyId: string;
}) {
  const linked = await LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds([
    params.llmApiKeyId,
  ]);
  return linked
    .map(({ model }) => model)
    .filter(
      (model) =>
        ModelModel.supportsTextChat(model) &&
        !modelIncompatibility({ runtime: params.runtime, model }),
    )
    .map((model) => ({
      id: model.id,
      modelId: model.modelId,
      displayName: model.description || model.modelId,
      provider: model.provider,
    }));
}

/** The Agent Runtime a saved runtime belongs to, if any. */
export function agentRuntimeFor(params: {
  runtime: Pick<TemplatedAgentRuntime, "image" | "command">;
  settings: RuntimeSettings;
}): AgentRuntimeTarget | null {
  const ref = resolveAgentRuntimeTemplate({
    runtime: params.runtime,
    catalogImages: config.agentRuntime.catalogImages,
    customTemplates: params.settings.templates.map(({ id, runtime }) => ({
      id,
      image: runtime.image,
    })),
  });
  return ref ? runtimeById({ id: ref.id, settings: params.settings }) : null;
}

export function runtimeById(params: {
  id: string;
  settings: RuntimeSettings;
}): AgentRuntimeTarget | null {
  const builtIn = PopularAgentIdSchema.safeParse(params.id);
  if (builtIn.success) {
    const id = builtIn.data;
    const defaults = params.settings.builtIns[id]?.settings;
    return {
      id,
      scope: agentRuntimePermissionScope({ kind: "built-in", id }),
      name: AGENT_CATALOG_NAMES[id],
      runtime: withAgentRuntimeDefaults({
        runtime: buildAgentCatalogRuntime({
          id,
          image: config.agentRuntime.catalogImages[id],
        }),
        defaults,
      }),
      setsImage: false,
      claudeAccount: defaults?.claudeCode?.authentication ?? null,
      accounts: defaults?.accounts,
    };
  }
  const template = params.settings.templates.find(({ id }) => id === params.id);
  return template
    ? {
        id: template.id,
        scope: template.id,
        name: template.name,
        runtime: template.runtime,
        setsImage: true,
        claudeAccount: template.runtime.claudeCode?.authentication ?? null,
        accounts: template.accounts,
      }
    : null;
}
// SPDX-SnippetEnd

/** The provider whose company connections are GitHub Copilot enterprise plans. */
export const COPILOT_PLAN_PROVIDER =
  "github-copilot" satisfies SupportedProvider;

// ===================================================================
// Internal helpers
// ===================================================================

/** The runtimes an organization's settings hold. */
type RuntimeSettings = Pick<RuntimeTemplateSettings, "templates" | "builtIns">;

/** What of a runtime the account rule is laid over, and found by. */
type RuleRuntime = Pick<
  ResolvedAgentRuntime,
  | "image"
  | "command"
  | "inferenceProtocol"
  | "claudeCode"
  | "accountLock"
  | "connectionModels"
>;

const NOT_AN_ENTERPRISE_PLAN =
  "The GitHub Copilot CLI runs on the company's enterprise plan, not on a provider API key. Choose an enterprise plan.";

/**
 * What a run that needs `kind` but finds no connected subscription is refused
 * with; the preflight reports the same before anyone starts a run.
 */
function personalSubscriptionRequiredMessage(params: {
  kind: SubscriptionCredentialKind;
  reason: "choice" | "lock" | "maintained";
}): string {
  const { label } = SUBSCRIPTION_CREDENTIALS[params.kind];
  return SUBSCRIPTION_REQUIRED_MESSAGES[params.reason](
    label,
    // The other account a person could choose: the Copilot CLI's is a plan.
    params.kind === "github-copilot"
      ? companyAccountWords("archestra-copilot")
      : companyAccountWords(null),
  );
}

const SUBSCRIPTION_REQUIRED_MESSAGES: Record<
  "choice" | "lock" | "maintained",
  (label: string, words: CompanyAccountWords) => string
> = {
  choice: (label, words) =>
    `Connect your own ${label} before starting this Agent, or choose ${words.a} as your account.`,
  lock: (label) =>
    `Connect your own ${label} before starting this Agent. It is locked to each person's own subscription.`,
  maintained: (label) =>
    `Connect your own ${label} before starting this Agent. The maintained runtime never falls back to usage-based API billing.`,
};

const CLAUDE_MODEL_MISPLACED_MESSAGE =
  "A Claude subscription model goes only with your own Claude subscription. Leave it empty.";

/**
 * The models a runtime sets for the connections it leaves open, laid over
 * the agent's own inputs. Where the agent sets one of those connections,
 * its model is the runtime's. Where the agent leaves the connection to each
 * person, the runtime's model for a connection holds for everyone who picks
 * it, before any the agent sets for it.
 */
function withRuntimeConnectionModels<Runtime extends RuleRuntime>(params: {
  inputs: AccountInputs<Runtime>;
  models: Record<string, string> | undefined;
}): AccountInputs<Runtime> {
  const { inputs } = params;
  const models = Object.entries(params.models ?? {});
  if (models.length === 0) return inputs;
  const { llmApiKeyId } = inputs.agent;
  if (llmApiKeyId) {
    const modelId = params.models?.[llmApiKeyId];
    return modelId
      ? {
          ...inputs,
          agent: { llmApiKeyId, modelId },
          fixedBy: { ...inputs.fixedBy, model: "runtime" },
        }
      : inputs;
  }
  return {
    ...inputs,
    fixedBy: {
      ...inputs.fixedBy,
      connectionModels: {
        ...inputs.fixedBy.connectionModels,
        ...Object.fromEntries(
          models.map(([id, modelId]) => [
            id,
            { modelId, by: "runtime" as const },
          ]),
        ),
      },
    },
  };
}

/** What refuses a choice of a part that a level above the person sets. */
function fixedPartMessage(
  part: "connection" | "model",
  by: "runtime" | "agent",
  words: CompanyAccountWords,
): string {
  const who = by === "runtime" ? "This agent's runtime" : "This agent";
  if (words.plan) {
    return part === "connection"
      ? `${who} sets its enterprise plan, so you cannot choose another.`
      : `${who} sets the model of its enterprise plan, so you cannot choose another.`;
  }
  return `${who} sets the ${part} of its company API key, so you cannot choose another.`;
}

/**
 * The connection or model the agent sets is gone, or no longer linked. The
 * reader is sent to their own subscription where the runtime has one, and to
 * the agent's editors where it has none.
 */
function companyAccountGone(params: {
  words: CompanyAccountWords;
  ownSubscription: boolean;
}): [reason: string, stale: string] {
  const own = params.words.plan ? "enterprise plan" : "API key";
  return [
    `This agent's own ${own} or model no longer works. ${params.ownSubscription ? USE_OWN_SUBSCRIPTION : "Someone who can edit the agent must choose them again."}`,
    `The agent's own ${own} or model is missing or no longer linked.`,
  ];
}

/**
 * The connection, or the model of a connection, the agent's runtime sets no
 * longer works: only the runtime's admins can choose another.
 */
function runtimeAccountGone(params: {
  words: CompanyAccountWords;
  part: "connection" | "model";
}): [reason: string, stale: string] {
  const { connection } = params.words;
  return params.part === "connection"
    ? [
        `The ${connection} this agent's runtime runs its agents on no longer works. Someone who can configure the runtime must choose another.`,
        `The ${connection} its runtime runs its agents on no longer works.`,
      ]
    : [
        `The model this agent's runtime sets for that ${connection} no longer works. Someone who can configure the runtime must choose another.`,
        `The model its runtime sets for the ${connection} you chose no longer works.`,
      ];
}

const USE_OWN_SUBSCRIPTION = "Choose your personal subscription instead.";

/** Whether a person can run on a subscription of their own on this runtime. */
function hasPersonalSubscription(runtime: ChoiceRuntime): boolean {
  return (
    runtimeSupportsClaudeSubscription(runtime) ||
    subscriptionKindForRuntimeCommand(runtime.command?.[0]) !== null
  );
}

/**
 * The organization's default model where `llmApiKeyId` serves it and it
 * runs on the runtime: the model of a connection whose model nobody set.
 */
async function organizationDefaultModelOn(params: {
  runtime: ChoiceRuntime;
  organizationId: string;
  llmApiKeyId: string;
}): Promise<Model | null> {
  const organization = await OrganizationModel.getById(params.organizationId);
  if (!organization?.defaultModelId) return null;
  const checked = await checkCompanyConnection({
    ...params,
    modelId: organization.defaultModelId,
  });
  return "problem" in checked ? null : checked.model;
}

/** Why a model cannot run on this runtime, or null when it can. */
function modelIncompatibility(params: {
  runtime: Pick<ResolvedAgentRuntime, "command" | "inferenceProtocol">;
  model: {
    provider: SupportedProvider;
    modelId: string;
    supportedEndpoints?: string[] | null;
  };
}): string | null {
  const compatibility = getAgentRuntimeModelCompatibility({
    inferenceProtocol: params.runtime.inferenceProtocol,
    runtimeCommand: params.runtime.command,
    provider: params.model.provider,
    modelId: params.model.modelId,
    supportedEndpoints: params.model.supportedEndpoints,
  });
  return compatibility.compatible ? null : compatibility.message;
}
