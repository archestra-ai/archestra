import { isDeepStrictEqual } from "node:util";
import {
  agentRuntimeCanNameAccountKind,
  COMPANY_ACCOUNT_WORDS,
  PopularAgentIdSchema,
} from "@archestra/shared";
import { userHasPermission } from "@/auth/utils";
import { LlmProviderApiKeyModel, TeamModel } from "@/models";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import type { AgentRuntime, AgentRuntimeAccountLock } from "@/types";
import { ApiError } from "@/types";
import type {
  RuntimeAccountsView,
  RuntimeTemplateEditorSettings,
  RuntimeTemplateSettings,
} from "@/types/agent-runtime-template";
import {
  type AgentRuntimeTarget,
  accountLockLabel,
  agentRuntimeFor,
  checkCompanyConnection,
  claudeAccountNamedByRuntime,
  fixedRuntimeAccount,
  listConnectionModelsForRuntime,
  lockedRuntimeAccountKind,
  runtimeAccountKind,
  runtimeById,
} from "./account-resolution";
import { getResolvedAgentRuntimeModelCompatibility } from "./model-compatibility";
import { agentOwnAccount } from "./user-account";

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

/**
 * The runtime a write stores, with the agent's account lock carried over: a
 * runtime that does not name `accountLock` keeps the stored one, including
 * none at all on an agent stored without the field. A runtime that
 * is new (no `previous`) and names none is stored with null: each person
 * chooses. An explicit null is stored as null. Apply before
 * `applyAgentRuntimeLock`, so an unchanged runtime still reads as unchanged.
 */
export function withStoredAccountLock<
  Runtime extends AgentRuntime | null | undefined,
>(params: {
  runtime: Runtime;
  previous: AgentRuntime | null | undefined;
}): Runtime {
  const { runtime } = params;
  if (!runtime) return runtime;
  const { accountLock, ...rest } = runtime;
  const lock =
    accountLock !== undefined
      ? accountLock
      : params.previous
        ? params.previous.accountLock
        : null;
  return (
    lock === undefined ? rest : { ...rest, accountLock: lock }
  ) as Runtime;
}

/**
 * Who may set an agent's account lock, and what a locked agent's save may
 * change. On a runtime that leaves the account to each agent, whoever may
 * configure the agent's runtime chooses it. On a locked runtime, or one whose
 * account rule names a kind, an administrator does; a locked runtime's own
 * Claude account sets the lock of its agents. While the agent is locked,
 * nobody else can change its own account, move it to another runtime or
 * remove its runtime. A lock must agree with the agent's own account,
 * whoever sets it.
 *
 * `runtime` is the runtime the write stores (undefined keeps the saved one);
 * `account` the key and model it stores.
 */
export async function assertAccountLockWrite(params: {
  organizationId: string;
  userId: string;
  previous: {
    runtime: AgentRuntime | null;
    llmApiKeyId: string | null;
    modelId: string | null;
  } | null;
  runtime: AgentRuntime | null | undefined;
  account: {
    llmApiKeyId?: string | null;
    modelId?: string | null;
  };
}): Promise<void> {
  const previousRuntime = params.previous?.runtime ?? null;
  const nextRuntime =
    params.runtime === undefined ? previousRuntime : params.runtime;
  const previousLock = previousRuntime?.accountLock ?? null;
  const nextLock = nextRuntime?.accountLock ?? null;
  // A runtime that names no lock runs only the way its own settings say.
  // Opening it to each person's choice is a change of who pays, like a lock.
  const opensOwnOnly =
    !!previousRuntime &&
    previousRuntime.accountLock === undefined &&
    nextRuntime?.accountLock === null;
  if (!previousLock && !nextLock && !opensOwnOnly) return;

  const settings = await AgentRuntimeTemplateModel.getSettings(
    params.organizationId,
  );
  const previousTarget = previousRuntime
    ? agentRuntimeFor({ runtime: previousRuntime, settings })
    : null;
  const nextTarget = nextRuntime
    ? agentRuntimeFor({ runtime: nextRuntime, settings })
    : null;
  const isAdministrator = () =>
    userHasPermission(
      params.userId,
      params.organizationId,
      "organizationSettings",
      "update",
    );
  // On a runtime that leaves the account kind to each agent, whoever may
  // configure an agent's runtime chooses its account; on a locked runtime,
  // or one whose rule names a kind, an administrator does.
  const buildsAgentAccount = async (target: AgentRuntimeTarget | null) =>
    !target?.locked &&
    runtimeAccountKind(target) === null &&
    (await userHasPermission(
      params.userId,
      params.organizationId,
      "agent",
      "configure-runtime",
    ));
  const mayChooseAccount = async (target: AgentRuntimeTarget | null) =>
    (await isAdministrator()) || (await buildsAgentAccount(target));
  // The lock a locked runtime writes on its agents is the runtime's, not a
  // choice of whoever saves the agent.
  const setByRuntime = (
    target: AgentRuntimeTarget | null,
    lock: AgentRuntimeAccountLock,
  ) => lockedRuntimeAccountKind(target) === lock;
  const who = (target: AgentRuntimeTarget | null) =>
    target?.locked || runtimeAccountKind(target)
      ? "an administrator"
      : "people who can configure an agent's runtime";

  const llmApiKeyId =
    params.account.llmApiKeyId !== undefined
      ? params.account.llmApiKeyId
      : (params.previous?.llmApiKeyId ?? null);
  const modelId =
    params.account.modelId !== undefined
      ? params.account.modelId
      : (params.previous?.modelId ?? null);
  const accountChanged =
    llmApiKeyId !== (params.previous?.llmApiKeyId ?? null) ||
    modelId !== (params.previous?.modelId ?? null) ||
    nextRuntime?.claudeCode?.authentication !==
      previousRuntime?.claudeCode?.authentication;
  const runtimeMoved =
    !!previousRuntime &&
    (!nextRuntime || previousTarget?.id !== nextTarget?.id);

  // Moved onto a runtime that leaves the account to each agent, the agent's
  // account is its builder's to choose there, as on a new agent.
  if (
    opensOwnOnly &&
    !(await mayChooseAccount(previousTarget)) &&
    !(runtimeMoved && (await buildsAgentAccount(nextTarget)))
  ) {
    throw new ApiError(
      403,
      `Only ${who(previousTarget)} can let each person choose the account for this agent.`,
    );
  }
  if (previousLock !== nextLock) {
    if (
      previousLock &&
      !setByRuntime(previousTarget, previousLock) &&
      !(await mayChooseAccount(previousTarget))
    ) {
      throw new ApiError(
        403,
        `This agent's account is locked. Only ${who(previousTarget)} can change or remove the lock.`,
      );
    }
    if (
      nextLock &&
      !setByRuntime(nextTarget, nextLock) &&
      !(await mayChooseAccount(nextTarget))
    ) {
      throw new ApiError(
        403,
        `Only ${who(nextTarget)} can lock the account of this agent.`,
      );
    }
  }
  if (
    previousLock &&
    !setByRuntime(previousTarget, previousLock) &&
    (accountChanged || runtimeMoved) &&
    !(await mayChooseAccount(previousTarget))
  ) {
    throw new ApiError(
      403,
      `This agent's account is locked. Only ${who(previousTarget)} can change its account or runtime.`,
    );
  }

  if (!nextRuntime || !nextLock) return;
  // The settings that decide the agent's own account kind, whoever may set
  // them: a Claude account its runtime sets is still what the lock is held to.
  const accountSettingsChanged =
    !!previousRuntime &&
    !isDeepStrictEqual(
      modelSettings(nextRuntime),
      modelSettings(previousRuntime),
    );
  if (
    previousLock === nextLock &&
    !accountChanged &&
    !runtimeMoved &&
    !accountSettingsChanged
  )
    return;
  await assertAccountLockFitsAgent({
    organizationId: params.organizationId,
    userId: params.userId,
    runtime: nextRuntime,
    lock: nextLock,
    agent: { llmApiKeyId, modelId },
  });
}

/**
 * The account lock a copy of an agent starts with, as a new agent does: each
 * person chooses, unless a locked runtime's Claude account sets it. Nothing
 * the runtime's account rule names or fixes is written on a copy: the rule
 * holds for the copy as for every agent of the runtime.
 */
export async function agentCopyAccountLock(params: {
  organizationId: string;
  runtime: AgentRuntime | null;
}): Promise<AgentRuntimeAccountLock | null | undefined> {
  if (!params.runtime) return undefined;
  const settings = await AgentRuntimeTemplateModel.getSettings(
    params.organizationId,
  );
  return lockedRuntimeAccountKind(
    agentRuntimeFor({ runtime: params.runtime, settings }),
  );
}

/**
 * The connection the account rule of an agent's runtime fixes for its
 * agents, or null when it fixes none. It is never stored on the agent: a
 * write reads it only to check a model the agent stores alone.
 */
export async function runtimeConnectionFor(params: {
  organizationId: string;
  runtime: AgentRuntime | null;
}): Promise<RuntimeConnection | null> {
  if (!params.runtime) return null;
  const target = agentRuntimeFor({
    runtime: params.runtime,
    settings: await AgentRuntimeTemplateModel.getSettings(
      params.organizationId,
    ),
  });
  const fixed = await fixedRuntimeAccount({ ...params, target });
  return target && fixed
    ? { llmApiKeyId: fixed.llmApiKeyId, runtimeName: target.name }
    : null;
}

/**
 * The runtime settings as a response carries them: each account rule with
 * the names of the connection and model it fixes, whether they still work,
 * and, with a connection fixed and no model, the models to pick from. A
 * reader who may not read the connection gets them too: they are what the
 * reader's agents run on. With `viewer`, someone who may neither configure
 * an agent's runtime nor change the organization's settings gets no rule.
 */
export async function withRuntimeAccountNames<
  Settings extends Pick<
    RuntimeTemplateEditorSettings,
    "templates" | "builtIns"
  >,
>(params: {
  organizationId: string;
  settings: Settings;
  viewer?: { userId: string };
}): Promise<Settings> {
  const { settings, organizationId } = params;
  const stored = [
    ...settings.templates.map(({ id, accounts }) => ({ id, accounts })),
    ...PopularAgentIdSchema.options.map((id) => ({
      id,
      accounts: settings.builtIns[id]?.settings.accounts,
    })),
  ].filter(({ accounts }) => accounts);
  if (stored.length === 0) return settings;
  const readable =
    !params.viewer || (await mayReadRuntimeRules(params.viewer.userId));
  const targets = readable
    ? stored.flatMap(({ id }) => {
        const target = runtimeById({ id, settings });
        return target ? [target] : [];
      })
    : [];
  // Each runtime's view reads its own connection and models: they are read
  // side by side, not one runtime after another.
  const views = new Map<string, RuntimeAccountsView>(
    await Promise.all(
      targets.map(
        async (target) =>
          [
            target.id,
            await runtimeAccountsView({ target, organizationId }),
          ] as const,
      ),
    ),
  );
  return {
    ...settings,
    templates: settings.templates.map(({ accounts, ...template }) => ({
      ...template,
      ...(views.has(template.id) && { accounts: views.get(template.id) }),
    })),
    builtIns: Object.fromEntries(
      Object.entries(settings.builtIns).map(([id, builtIn]) => {
        if (!builtIn) return [id, builtIn];
        const { accounts, ...rest } = builtIn.settings;
        return [
          id,
          {
            ...builtIn,
            settings: {
              ...rest,
              ...(views.has(id) && { accounts: views.get(id) }),
            },
          },
        ];
      }),
    ),
  };

  async function mayReadRuntimeRules(userId: string): Promise<boolean> {
    const [configuresRuntimes, administers] = await Promise.all([
      userHasPermission(userId, organizationId, "agent", "configure-runtime"),
      userHasPermission(
        userId,
        organizationId,
        "organizationSettings",
        "update",
      ),
    ]);
    return configuresRuntimes || administers;
  }
}

/**
 * Refuse an account rule a runtime cannot hold, before it is saved: an
 * account kind where the runtime's agents have one kind only, or one its
 * own Claude account contradicts; a model without its connection; a
 * connection where the rule names subscriptions only; a connection that is
 * someone's own, or that the person saving could not pick for an agent of
 * theirs; and a connection or model that fails the checks an agent's own
 * pass. Only runtimes whose rule changed are checked, so one whose
 * connection was deleted since still saves its other settings.
 */
export async function assertRuntimeAccountSettings(params: {
  organizationId: string;
  /** The person saving. */
  userId: string;
  settings: RuntimeTemplateSettings;
  previous: RuntimeTemplateSettings;
}): Promise<void> {
  const words = COMPANY_ACCOUNT_WORDS;
  const ids = [
    ...PopularAgentIdSchema.options,
    ...params.settings.templates.map(({ id }) => id),
  ];
  for (const id of ids) {
    const target = runtimeById({ id, settings: params.settings });
    if (!target?.accounts) continue;
    const before = runtimeById({ id, settings: params.previous });
    if (
      before &&
      isDeepStrictEqual(accountSettings(target), accountSettings(before))
    )
      continue;
    const { kind, llmApiKeyId, modelId } = target.accounts;
    if (kind && !agentRuntimeCanNameAccountKind(target.runtime)) {
      throw new ApiError(
        400,
        target.setsImage
          ? `The agents of the ${target.name} runtime have one account kind, so there is none to name. Only a runtime whose command is the Claude Code or Codex wrapper has two.`
          : `The ${target.name} runtime runs on a company API key only, so it has no account kind to name.`,
      );
    }
    // A Claude account the settings store beside the rule starts new
    // agents, or a locked runtime's agents run on it: it must be the one of
    // the kind the rule names.
    const named = claudeAccountNamedByRuntime(target);
    if (
      kind &&
      named &&
      target.claudeAccount &&
      target.claudeAccount !== named
    ) {
      throw new ApiError(
        400,
        `The ${target.name} runtime names ${accountLockLabel(kind, words)} for its agents, but its Claude account is set to the other. Set both to the same account.`,
      );
    }
    if (modelId && !llmApiKeyId) {
      throw new ApiError(
        400,
        `Choose the ${words.connection} of the ${target.name} runtime before its model.`,
      );
    }
    if (!llmApiKeyId) continue;
    if (kind === "subscription") {
      throw new ApiError(
        400,
        `The ${target.name} runtime runs on personal subscriptions only, so it has no company connection to fix.`,
      );
    }
    // Fixing a connection gives it to everyone who uses the runtime, so the
    // person saving must be able to pick it for an agent of their own.
    const selectable = await LlmProviderApiKeyModel.getAvailableKeysForUser(
      params.organizationId,
      params.userId,
      await TeamModel.getUserTeamIds(params.userId),
    );
    const key = await LlmProviderApiKeyModel.findById(llmApiKeyId);
    if (!key || key.organizationId !== params.organizationId) {
      throw new ApiError(400, RUNTIME_CONNECTION_PROBLEMS.missing(target.name));
    }
    // A connection with an owner is that person's: nobody else's agents
    // run on it, whatever kind of credential it holds.
    if (key.userId) {
      throw new ApiError(
        400,
        RUNTIME_CONNECTION_PROBLEMS.personal(target.name),
      );
    }
    if (!selectable.some(({ id: selectableId }) => selectableId === llmApiKeyId)) {
      throw new ApiError(
        403,
        `You cannot use the ${words.connection} chosen for the ${target.name} runtime yourself, so you cannot give it to the runtime's agents. Choose ${words.aConnection} that is shared with you.`,
      );
    }
    const checked = await checkCompanyConnection({
      runtime: target.runtime,
      organizationId: params.organizationId,
      llmApiKeyId,
      modelId: modelId ?? null,
    });
    if (!("problem" in checked)) continue;
    throw new ApiError(
      400,
      checked.problem === "incompatible"
        ? `The ${words.connection} or model chosen for the ${target.name} runtime does not run on it. ${checked.message}`
        : RUNTIME_CONNECTION_PROBLEMS[checked.problem](target.name),
    );
  }
}

// ===================================================================
// Internal
// ===================================================================

/** The connection a runtime fixes for its agents, for a write's checks. */
type RuntimeConnection = { llmApiKeyId: string; runtimeName: string };

/** One runtime's account rule with what a response adds to it. */
async function runtimeAccountsView(params: {
  target: AgentRuntimeTarget;
  organizationId: string;
}): Promise<RuntimeAccountsView> {
  const { target } = params;
  const { kind, llmApiKeyId, modelId } = target.accounts ?? {};
  const fixed = await fixedRuntimeAccount(params);
  const base = {
    ...(kind && { kind }),
    ...(llmApiKeyId && { llmApiKeyId }),
    ...(modelId && { modelId }),
  };
  if (!fixed) return base;
  const view = {
    ...base,
    ...(fixed.keyName && { keyName: fixed.keyName }),
    ...(fixed.keyProvider && { keyProvider: fixed.keyProvider }),
    ...(fixed.modelName && { modelName: fixed.modelName }),
    ...(fixed.keyMissing && { keyMissing: true }),
    ...(fixed.modelMissing && { modelMissing: true }),
  };
  if (fixed.keyMissing || fixed.modelId) return view;
  // The connection's models that run on this runtime, for whoever builds an
  // agent on it to pick from.
  return {
    ...view,
    models: await listConnectionModelsForRuntime({
      runtime: target.runtime,
      llmApiKeyId: fixed.llmApiKeyId,
    }),
  };
}

/** What decides whether a runtime's account rule must be checked again. */
function accountSettings(target: AgentRuntimeTarget) {
  return [
    target.accounts?.kind,
    target.accounts?.llmApiKeyId,
    target.accounts?.modelId,
    target.runtime.command,
    target.runtime.inferenceProtocol,
    target.claudeAccount,
  ];
}

const RUNTIME_CONNECTION_PROBLEMS = {
  missing: (runtime: string) =>
    `The ${COMPANY_ACCOUNT_WORDS.connection} chosen for the ${runtime} runtime does not exist in this organization.`,
  personal: (runtime: string) =>
    `The ${COMPANY_ACCOUNT_WORDS.connection} chosen for the ${runtime} runtime is someone's personal one. Choose a company connection.`,
  model: (runtime: string) =>
    `The model chosen for the ${runtime} runtime is not one of the models of its ${COMPANY_ACCOUNT_WORDS.connection}.`,
};

/**
 * A lock must agree with the kind of the agent's account as its runs
 * resolve it: the agent's own, with the account rule of its runtime laid
 * over it. A company-key lock asks for no connection or model of the
 * agent's: what the agent and its runtime leave unset is each person's to
 * choose, then the organization's default. A connection the agent does
 * store must hold an API key, not someone's subscription. Where the
 * runtime's rule names another kind than the lock being stored, the stored
 * lock plays no part in any run, and is judged against the agent's own
 * settings alone: the rule governs the agent's runs, not what may be saved
 * on it.
 */
async function assertAccountLockFitsAgent(params: {
  organizationId: string;
  userId: string;
  runtime: AgentRuntime;
  lock: AgentRuntimeAccountLock;
  agent: { llmApiKeyId: string | null; modelId: string | null };
}): Promise<void> {
  const { lock } = params;
  const words = COMPANY_ACCOUNT_WORDS;
  const stored = {
    runtime: { ...params.runtime, accountLock: lock },
    agent: params.agent,
  };
  const resolved = await getResolvedAgentRuntimeModelCompatibility({
    organizationId: params.organizationId,
    userId: params.userId,
    ...stored,
  });
  const inputs =
    resolved.inputs.runtime.accountLock === lock ? resolved.inputs : stored;
  const { agent } = inputs;
  const own = await agentOwnAccount({
    // A subscription lock is held to the connection the agent stores: one
    // its runtime fixes is the company API key's.
    agent: lock === "subscription" && "own" in inputs ? inputs.own : agent,
    runtime: inputs.runtime,
    organizationId: params.organizationId,
    userId: params.userId,
  });
  if (lock === "subscription") {
    if (own.authentication !== "subscription") {
      throw new ApiError(
        400,
        "To lock this agent to each person's own subscription, its own account must be a personal subscription.",
      );
    }
    return;
  }
  if (own.authentication !== "provider") {
    throw new ApiError(
      400,
      `To lock this agent to ${words.a}, its own account must be ${words.a}.`,
    );
  }
  const key = agent.llmApiKeyId
    ? await LlmProviderApiKeyModel.findByIdWithSubscriptionInfo(
        agent.llmApiKeyId,
      )
    : null;
  if (key && (await LlmProviderApiKeyModel.isPersonalCredential(key))) {
    throw new ApiError(
      400,
      `To lock this agent to ${words.a}, give it ${words.a} rather than a personal subscription.`,
    );
  }
}

function modelSettings(runtime: AgentRuntime) {
  return [
    runtime.command,
    runtime.inferenceProtocol,
    runtime.claudeCode?.authentication,
  ];
}
// SPDX-SnippetEnd
