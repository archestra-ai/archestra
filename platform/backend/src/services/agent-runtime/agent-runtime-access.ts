import { isDeepStrictEqual } from "node:util";
import {
  agentRuntimeCanNameAccountKind,
  agentRuntimePermissionScope,
  type CompanyAccountWords,
  companyAccountWords,
  hasScopedPermission,
  PopularAgentIdSchema,
  startingClaudeAuthentication,
  withAgentRuntimeTemplateSettings,
} from "@archestra/shared";
import { withDbTransaction } from "@/database";
import {
  AgentModel,
  LlmProviderApiKeyModel,
  ModelModel,
  TeamModel,
} from "@/models";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import {
  applyAgentAutoRouter,
  applyAgentModelPool,
} from "@/services/chat-model-pools";
import { ResourcePermissions } from "@/services/resource-permissions";
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
  runtimeAccountKind,
  runtimeById,
} from "./account-resolution";
import { assertAgentRuntimeModelCompatibility } from "./agent-config-validation";
import { getResolvedAgentRuntimeModelCompatibility } from "./model-compatibility";
import { agentOwnAccount } from "./user-account";

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

/**
 * The runtime an agent save may store. Putting an agent on an Agent Runtime,
 * or changing the runtime of an agent already on one, needs `use` on that
 * runtime. Without `configure` on it the agent takes the runtime's own
 * settings; its environment, credentials and ports stay its own, and so do
 * its account and its lock. Nothing of the runtime's account rule is written
 * on an agent: the rule holds for the agent's runs while it stands, and the
 * agent keeps what it stores underneath, which is what its runs go back to
 * once the rule is removed. A runtime that is none of the organization's
 * runtimes is free-form, so it needs `configure` on every runtime.
 */
export async function applyAgentRuntimeAccess<
  Runtime extends AgentRuntime | null | undefined,
>(params: {
  organizationId: string;
  userId: string;
  runtime: Runtime;
  /** The agent's saved runtime, when it has one. */
  previous?: AgentRuntime | null;
}): Promise<Runtime> {
  // An omitted or unchanged runtime keeps what is saved, so ordinary edits
  // still work after someone loses access to the agent's runtime.
  if (
    params.runtime === undefined ||
    isDeepStrictEqual(params.runtime, params.previous ?? null)
  )
    return params.runtime;
  const settings = await AgentRuntimeTemplateModel.getSettings(
    params.organizationId,
  );
  const left = params.previous
    ? agentRuntimeFor({ runtime: params.previous, settings })
    : null;
  if (params.previous) {
    await requireRuntimeAction({
      ...params,
      runtime: left,
      action: left ? "use" : "configure",
    });
  }
  if (params.runtime === null) return params.runtime;
  const target = agentRuntimeFor({ runtime: params.runtime, settings });
  if (!target) {
    await requireRuntimeAction({
      ...params,
      runtime: null,
      action: "configure",
    });
    return params.runtime;
  }
  const { configure } = await requireRuntimeAction({
    ...params,
    runtime: target,
    action: "use",
  });
  if (configure) return params.runtime;
  const applied = withRuntimeSettings({ runtime: params.runtime, target });
  // A new agent, and an agent moved here from another runtime, that names
  // no Claude account starts on the runtime's.
  if (params.previous && left?.id === target.id) return applied as Runtime;
  return withStartingClaudeAccount({ runtime: applied, target }) as Runtime;
}

/**
 * The runtime a write stores, with the agent's account lock carried over: a
 * runtime that does not name `accountLock` keeps the stored one, including
 * none at all on an agent stored without the field. A runtime that
 * is new (no `previous`) and names none is stored with null: each person
 * chooses. An explicit null is stored as null. Apply before
 * `applyAgentRuntimeAccess`, so an unchanged runtime still reads as unchanged.
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
 * change. Setting, changing or removing the lock needs `configure` on the
 * agent's runtime, or `use` on a runtime that leaves the account to each
 * agent: there, whoever builds the agent chooses it. While the agent is
 * locked, anyone else cannot change its own account, move it to another
 * runtime or remove its runtime. A lock must agree with the agent's own
 * account, whoever sets it.
 *
 * `runtime` is the runtime the write stores (undefined keeps the saved one);
 * `account` the key, model and pool it stores, after a pool is applied.
 */
export async function assertAccountLockWrite(params: {
  organizationId: string;
  userId: string;
  previous: {
    runtime: AgentRuntime | null;
    llmApiKeyId: string | null;
    modelId: string | null;
    /** Needed only by callers that can send a pool. */
    modelPoolId?: string | null;
  } | null;
  runtime: AgentRuntime | null | undefined;
  account: {
    llmApiKeyId?: string | null;
    modelId?: string | null;
    modelPoolId?: string | null;
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
  const mayUse = async (target: AgentRuntimeTarget) =>
    (await runtimeActions({ ...params, scope: target.scope })).use;
  // On a runtime that leaves the account kind to each agent, whoever may put
  // agents on it chooses their account; anywhere else its configurers do.
  const buildsAgentAccount = async (target: AgentRuntimeTarget | null) =>
    !!target && runtimeAccountKind(target) === null && (await mayUse(target));
  const mayChooseAccount = async (target: AgentRuntimeTarget | null) =>
    (await runtimeActions({ ...params, scope: target?.scope ?? "*" }))
      .configure || (await buildsAgentAccount(target));
  const who = (target: AgentRuntimeTarget | null) =>
    target
      ? `people who can configure the ${target.name} runtime`
      : "people who can configure every Agent Runtime";

  const llmApiKeyId =
    params.account.llmApiKeyId !== undefined
      ? params.account.llmApiKeyId
      : (params.previous?.llmApiKeyId ?? null);
  const modelId =
    params.account.modelId !== undefined
      ? params.account.modelId
      : (params.previous?.modelId ?? null);
  const accountChanged =
    (params.account.modelPoolId !== undefined &&
      (params.account.modelPoolId ?? null) !==
        (params.previous?.modelPoolId ?? null)) ||
    llmApiKeyId !== (params.previous?.llmApiKeyId ?? null) ||
    modelId !== (params.previous?.modelId ?? null) ||
    nextRuntime?.claudeCode?.authentication !==
      previousRuntime?.claudeCode?.authentication ||
    !isDeepStrictEqual(
      nextRuntime?.connectionModels ?? {},
      previousRuntime?.connectionModels ?? {},
    );
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
      `Only ${who(previousTarget)} can let each person choose the account for its agents.`,
    );
  }
  if (previousLock !== nextLock) {
    if (previousLock && !(await mayChooseAccount(previousTarget))) {
      throw new ApiError(
        403,
        `This agent's account is locked. Only ${who(previousTarget)} can change or remove the lock.`,
      );
    }
    if (nextLock && !(await mayChooseAccount(nextTarget))) {
      throw new ApiError(
        403,
        `Only ${who(nextTarget)} can lock the account of its agents.`,
      );
    }
  }
  if (previousLock && (accountChanged || runtimeMoved)) {
    if (!(await mayChooseAccount(previousTarget))) {
      throw new ApiError(
        403,
        `This agent's account is locked. Only ${who(previousTarget)} can change its account or runtime.`,
      );
    }
    if (runtimeMoved && nextLock && !(await mayChooseAccount(nextTarget))) {
      throw new ApiError(
        403,
        `Only ${who(nextTarget)} can lock the account of its agents.`,
      );
    }
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

/** Reading a runtime's starting configuration needs `use` on it. */
export async function assertCanUseAgentRuntime(params: {
  organizationId: string;
  userId: string;
  runtime: AgentRuntime | null;
}): Promise<void> {
  if (!params.runtime) return;
  const settings = await AgentRuntimeTemplateModel.getSettings(
    params.organizationId,
  );
  const target = agentRuntimeFor({ runtime: params.runtime, settings });
  await requireRuntimeAction({
    ...params,
    runtime: target,
    action: target ? "use" : "configure",
  });
}

/**
 * Copying an agent needs `use` on its runtime; the copy keeps its settings
 * but not the source's account lock or its key. Answers the account lock a
 * copy starts with, as a new agent does: each person chooses. Nothing its
 * runtime's account rule names or fixes is written on a copy: the rule
 * holds for the copy as for every agent of the runtime.
 */
export async function agentCopyAccountLock(params: {
  organizationId: string;
  userId: string;
  runtime: AgentRuntime | null;
}): Promise<AgentRuntimeAccountLock | null | undefined> {
  if (!params.runtime) return undefined;
  const settings = await AgentRuntimeTemplateModel.getSettings(
    params.organizationId,
  );
  const target = agentRuntimeFor({ runtime: params.runtime, settings });
  await requireRuntimeAction({
    ...params,
    runtime: target,
    action: target ? "use" : "configure",
  });
  return null;
}

/**
 * The model account an agent write stores, applied in place by the one
 * sequence every write path follows, so an agent saved through the API and
 * one saved through the MCP tools end in the same state. An auto router
 * replaces the model, key and pool, and an Agent Runtime agent or a picked
 * model leaves the router. A picked pool stores one of its members as the
 * key and model, and a picked key or model leaves the pool.
 *
 * Nothing of the account rule of the agent's runtime is written here: a
 * connection or model the runtime fixes holds for the agent's runs without
 * being stored on it. `runtimeConnection` names that connection for the
 * caller's checks, since on such a runtime an agent may store a model
 * alone, which must then be one of that connection's models.
 *
 * `runtime` is the runtime the write stores (undefined keeps the saved one).
 */
export async function applyAgentAccountWrite(params: {
  organizationId: string;
  userId: string;
  previous: { runtime: AgentRuntime | null } | null;
  runtime: AgentRuntime | null | undefined;
  /** A built-in agent cannot run on an auto router. */
  builtIn?: boolean;
  account: {
    autoRouterId?: string | null;
    modelPoolId?: string | null;
    llmApiKeyId?: string | null;
    modelId?: string | null;
  };
}): Promise<{ runtimeConnection: RuntimeConnection | null }> {
  const { account, organizationId, userId } = params;
  const runtime =
    params.runtime === undefined
      ? (params.previous?.runtime ?? null)
      : params.runtime;
  await applyAgentAutoRouter(account, {
    organizationId,
    runtime,
    builtIn: params.builtIn,
  });
  await applyAgentModelPool(account, { organizationId, userId });
  return {
    runtimeConnection: await runtimeConnectionFor({ organizationId, runtime }),
  };
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
 * reader's agents run on. With `viewer`, a runtime that person may neither
 * use nor configure comes without its rule.
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
  const targets = stored.flatMap(({ id }) => {
    const target = runtimeById({ id, settings });
    return target ? [target] : [];
  });
  const readable = params.viewer
    ? await runtimesWithinReach({
        organizationId,
        userId: params.viewer.userId,
        scopes: targets.map(({ scope }) => scope),
      })
    : null;
  // Each runtime's view reads its own connection and models: they are read
  // side by side, not one runtime after another.
  const views = new Map<string, RuntimeAccountsView>(
    await Promise.all(
      targets
        .filter(({ scope }) => !readable || readable.has(scope))
        .map(
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
    const { kind, llmApiKeyId, modelId, connectionModels } = target.accounts;
    const words = companyAccountWords(target.runtime.command?.[0]);
    if (kind && !agentRuntimeCanNameAccountKind(target.runtime)) {
      throw new ApiError(
        400,
        target.setsImage
          ? `The agents of the ${target.name} runtime have one account kind, so there is none to name. Only a custom runtime that sets a Claude account, or whose command is the Codex, Grok Build or Copilot CLI wrapper, has two.`
          : `The ${target.name} runtime runs on a company API key only, so it has no account kind to name.`,
      );
    }
    // A Claude account the settings store beside the rule starts new
    // agents: it must be the one of the kind the rule names.
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
    // A model set for each connection the runtime leaves open, and the
    // connection and model it fixes, pass the same checks.
    const planModels = Object.entries(connectionModels ?? {});
    if (planModels.length > 0 && llmApiKeyId) {
      throw new ApiError(
        400,
        `The ${target.name} runtime fixes one ${words.connection} for its agents, so there is no other to set a model for.`,
      );
    }
    const pairs: [string, string | null][] = llmApiKeyId
      ? [[llmApiKeyId, modelId ?? null]]
      : planModels;
    if (pairs.length === 0) continue;
    if (kind === "subscription") {
      throw new ApiError(
        400,
        `The ${target.name} runtime runs on personal subscriptions only, so it has no ${words.plan ? "enterprise plan" : "company connection"} to fix.`,
      );
    }
    // Fixing a connection gives it to everyone who uses the runtime, so the
    // person saving must be able to pick it for an agent of their own.
    const selectable = await LlmProviderApiKeyModel.getAvailableKeysForUser(
      params.organizationId,
      params.userId,
      await TeamModel.getUserTeamIds(params.userId),
    );
    for (const [connectionId, connectionModelId] of pairs) {
      const key = await LlmProviderApiKeyModel.findById(connectionId);
      if (!key || key.organizationId !== params.organizationId) {
        throw new ApiError(
          400,
          RUNTIME_CONNECTION_PROBLEMS.missing(target.name, words),
        );
      }
      // A connection with an owner is that person's: nobody else's agents
      // run on it, whatever kind of credential it holds.
      if (key.userId) {
        throw new ApiError(
          400,
          RUNTIME_CONNECTION_PROBLEMS.personal(target.name, words),
        );
      }
      if (!selectable.some(({ id }) => id === connectionId)) {
        throw new ApiError(
          403,
          `You cannot use the ${words.connection} chosen for the ${target.name} runtime yourself, so you cannot give it to the runtime's agents. Choose ${words.aConnection} that is shared with you.`,
        );
      }
      const checked = await checkCompanyConnection({
        runtime: target.runtime,
        organizationId: params.organizationId,
        llmApiKeyId: connectionId,
        modelId: connectionModelId,
      });
      if (!("problem" in checked)) continue;
      throw new ApiError(
        400,
        checked.problem === "incompatible"
          ? `The ${words.connection} or model chosen for the ${target.name} runtime does not run on it. ${checked.message}`
          : RUNTIME_CONNECTION_PROBLEMS[checked.problem](target.name, words),
      );
    }
  }
}

/**
 * Which Agent Runtimes the caller may put agents on and configure, and
 * whether they may run an image that is none of them.
 */
export async function listAgentRuntimeAccess(params: {
  organizationId: string;
  userId: string;
}): Promise<{
  runtimes: { id: string; canUse: boolean; canConfigure: boolean }[];
  canConfigureAny: boolean;
}> {
  const { templates } = await AgentRuntimeTemplateModel.getSettings(
    params.organizationId,
  );
  const runtimes = [
    ...PopularAgentIdSchema.options.map((id) => ({
      id,
      scope: agentRuntimePermissionScope({ kind: "built-in", id }),
    })),
    ...templates.map(({ id }) => ({ id, scope: id })),
  ];
  const scopes = runtimes.map(({ scope }) => scope);
  const [usable, configurable, any] = await Promise.all([
    ResourcePermissions.getPermittedIds({
      ...params,
      resource: "agentRuntime",
      scopes,
      action: "use",
    }),
    ResourcePermissions.getPermittedIds({
      ...params,
      resource: "agentRuntime",
      scopes,
      action: "configure",
    }),
    runtimeActions({ ...params, scope: "*" }),
  ]);
  return {
    runtimes: runtimes.map(({ id, scope }) => ({
      id,
      canUse: usable.has(scope),
      canConfigure: configurable.has(scope),
    })),
    canConfigureAny: any.configure,
  };
}

/**
 * How many existing agents of one Agent Runtime differ from its settings.
 * The runtime's account rule is not among them: it holds for every agent as
 * it is, with nothing to apply.
 */
export async function countAgentsBehindRuntime(params: {
  organizationId: string;
  runtimeId: string;
}): Promise<number> {
  const settings = await AgentRuntimeTemplateModel.getSettings(
    params.organizationId,
  );
  const target = runtimeById({ id: params.runtimeId, settings });
  if (!target) throw new ApiError(404, "Agent Runtime not found");
  return runtimeChanges({
    agents: await AgentModel.findWithRuntime({
      organizationId: params.organizationId,
    }),
    settings,
    target,
  }).length;
}

/**
 * Give every existing agent of one Agent Runtime that runtime's current
 * settings. Refuses, naming them, when the new settings would stop agents
 * working with their model. The runtime's account rule needs no applying
 * and is not written to any agent.
 */
export async function applyAgentRuntimeToAgents(params: {
  organizationId: string;
  userId: string;
  runtimeId: string;
}): Promise<{ name: string; agents: { id: string; name: string }[] }> {
  const settings = await AgentRuntimeTemplateModel.getSettings(
    params.organizationId,
  );
  const target = runtimeById({ id: params.runtimeId, settings });
  if (!target) throw new ApiError(404, "Agent Runtime not found");
  const changes = runtimeChanges({
    agents: await AgentModel.findWithRuntime({
      organizationId: params.organizationId,
    }),
    settings,
    target,
  });
  const incompatible: string[] = [];
  const unfitLock: string[] = [];
  for (const { agent, runtime } of changes) {
    // Only the settings that choose a model API can break an Agent's model.
    if (isDeepStrictEqual(modelSettings(runtime), modelSettings(agent.runtime)))
      continue;
    try {
      await assertAgentRuntimeModelCompatibility({
        runtime,
        agent,
        organizationId: params.organizationId,
        userId: params.userId,
        selectsModel: false,
      });
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode !== 409) throw error;
      incompatible.push(agent.name);
      continue;
    }
    // The same settings can change the agent's own account kind, which its
    // lock must still allow or every run of it is refused.
    const lock = runtime.accountLock ?? null;
    if (!lock) continue;
    try {
      await assertAccountLockFitsAgent({
        organizationId: params.organizationId,
        userId: params.userId,
        runtime,
        lock,
        agent,
      });
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode >= 500) throw error;
      unfitLock.push(agent.name);
    }
  }
  if (incompatible.length > 0) {
    throw new ApiError(
      409,
      `These settings don't work with the model of: ${incompatible.join(", ")}. Change those agents' model first.`,
    );
  }
  if (unfitLock.length > 0) {
    throw new ApiError(
      409,
      `These settings don't work with the account lock of: ${unfitLock.join(", ")}. Change or remove those agents' lock first.`,
    );
  }
  // Re-read the agents under row locks, so an agent saved meanwhile is
  // updated from what it now holds rather than from the read above.
  return withDbTransaction(async (tx) => {
    const current = runtimeChanges({
      agents: await AgentModel.findWithRuntime({
        organizationId: params.organizationId,
        tx,
      }),
      settings,
      target,
    });
    for (const { agent, runtime } of current) {
      await AgentModel.setRuntime({ id: agent.id, runtime, tx });
    }
    return {
      name: target.name,
      agents: current.map(({ agent }) => ({ id: agent.id, name: agent.name })),
    };
  });
}

// ===================================================================
// Internal
// ===================================================================

async function runtimeActions(params: {
  organizationId: string;
  userId: string;
  scope: string;
}): Promise<{ use: boolean; configure: boolean }> {
  const context = {
    userId: params.userId,
    organizationId: params.organizationId,
    resource: "agentRuntime" as const,
    scope: params.scope,
  };
  const grants = await ResourcePermissions.resolve(context);
  return {
    use: hasScopedPermission({
      grants,
      required: { ...context, action: "use" },
    }),
    configure: hasScopedPermission({
      grants,
      required: { ...context, action: "configure" },
    }),
  };
}

async function requireRuntimeAction(params: {
  organizationId: string;
  userId: string;
  /** Null for an image that is none of the organization's runtimes. */
  runtime: AgentRuntimeTarget | null;
  action: "use" | "configure";
}): Promise<{ use: boolean; configure: boolean }> {
  const actions = await runtimeActions({
    ...params,
    scope: params.runtime?.scope ?? "*",
  });
  if (actions[params.action]) return actions;
  throw new ApiError(
    403,
    params.runtime
      ? `You don't have permission to use the ${params.runtime.name} runtime.`
      : "Only people who can configure every Agent Runtime can run an image that isn't one of the organization's runtimes.",
  );
}

/** The connection a runtime fixes for its agents, for a write's checks. */
type RuntimeConnection = { llmApiKeyId: string; runtimeName: string };

/** The runtimes among `scopes` the person may use or configure. */
async function runtimesWithinReach(params: {
  organizationId: string;
  userId: string;
  scopes: string[];
}): Promise<Set<string>> {
  const [usable, configurable] = await Promise.all(
    (["use", "configure"] as const).map((action) =>
      ResourcePermissions.getPermittedIds({
        ...params,
        resource: "agentRuntime",
        action,
      }),
    ),
  );
  return new Set([...usable, ...configurable]);
}

/** One runtime's account rule with what a response adds to it. */
async function runtimeAccountsView(params: {
  target: AgentRuntimeTarget;
  organizationId: string;
}): Promise<RuntimeAccountsView> {
  const { target } = params;
  const { kind, llmApiKeyId, modelId, connectionModels } =
    target.accounts ?? {};
  const planModels = Object.entries(connectionModels ?? {});
  const [named, fixed] = await Promise.all([
    planModels.length > 0
      ? ModelModel.findByIds(planModels.map(([, model]) => model))
      : [],
    fixedRuntimeAccount(params),
  ]);
  const names = new Map(
    named.map((row) => [row.id, row.description || row.modelId]),
  );
  const base = {
    ...(kind && { kind }),
    ...(llmApiKeyId && { llmApiKeyId }),
    ...(modelId && { modelId }),
    ...(planModels.length > 0 && {
      connectionModels,
      // By name too: whoever builds an agent on the runtime may not be able
      // to list a connection's models.
      connectionModelNames: Object.fromEntries(
        planModels.flatMap(([id, model]) => {
          const name = names.get(model);
          return name ? [[id, name]] : [];
        }),
      ),
    }),
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
    target.accounts?.connectionModels,
    target.runtime.command,
    target.runtime.inferenceProtocol,
    target.claudeAccount,
  ];
}

const RUNTIME_CONNECTION_PROBLEMS = {
  missing: (runtime: string, words: CompanyAccountWords) =>
    `The ${words.connection} chosen for the ${runtime} runtime does not exist in this organization.`,
  personal: (runtime: string, words: CompanyAccountWords) =>
    `The ${words.connection} chosen for the ${runtime} runtime is someone's personal one. Choose ${words.plan ? "an enterprise plan" : "a company connection"}.`,
  model: (runtime: string, words: CompanyAccountWords) =>
    `The model chosen for the ${runtime} runtime is not one of the models of its ${words.connection}.`,
};

/**
 * A new agent that names no Claude account, put on a runtime by someone who
 * may only use it, starts on the runtime's: the catalog's for the maintained
 * Claude Code runtime, or the one its settings store; a custom runtime's
 * own, which also declares that its image runs Claude Code. On a custom
 * runtime a stored subscription starts it on the company API key unless the
 * runtime's rule names subscriptions, as every agent there ran before. It is
 * a starting value and no lock: it is never written over one an agent names,
 * nor on an agent already there.
 */
function withStartingClaudeAccount(params: {
  runtime: AgentRuntime;
  target: AgentRuntimeTarget;
}): AgentRuntime {
  const { runtime, target } = params;
  const { claudeCode } = target.runtime;
  if (!claudeCode || runtime.claudeCode) return runtime;
  const authentication =
    startingClaudeAuthentication({
      runtime: target.runtime,
      ruleKind: runtimeAccountKind(target),
    }) ?? claudeCode.authentication;
  return { ...runtime, claudeCode: { ...claudeCode, authentication } };
}

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
  const words = companyAccountWords(params.runtime.command?.[0]);
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

/**
 * The runtime with its Agent Runtime's own settings applied. Those never
 * include a Claude account: an agent's own is changed only by a write that
 * names it, never to follow the kind its runtime's account rule names.
 */
function withRuntimeSettings(params: {
  runtime: AgentRuntime;
  target: AgentRuntimeTarget;
}): AgentRuntime {
  const runtime: AgentRuntime = withAgentRuntimeTemplateSettings({
    runtime: params.runtime,
    template: params.target.runtime,
  });
  return params.target.setsImage
    ? { ...runtime, image: params.target.runtime.image }
    : runtime;
}

function modelSettings(runtime: AgentRuntime) {
  return [
    runtime.command,
    runtime.inferenceProtocol,
    runtime.claudeCode?.authentication,
  ];
}

/**
 * The agents of `target` whose runtime differs from its settings. Nothing of
 * an agent's account is among them: an account rule holds for every agent
 * as it is, and a Claude account the settings store only starts new agents.
 */
function runtimeChanges<Agent extends { runtime: AgentRuntime }>(params: {
  agents: Agent[];
  settings: RuntimeTemplateSettings;
  target: AgentRuntimeTarget;
}) {
  return params.agents.flatMap((agent) => {
    if (
      agentRuntimeFor({ runtime: agent.runtime, settings: params.settings })
        ?.id !== params.target.id
    )
      return [];
    const runtime = withRuntimeSettings({
      runtime: agent.runtime,
      target: params.target,
    });
    return isDeepStrictEqual(runtime, agent.runtime)
      ? []
      : [{ agent, runtime }];
  });
}
// SPDX-SnippetEnd
