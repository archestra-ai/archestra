import {
  companyAccountWords,
  findAgentRuntimeTier,
  isModelSelectionComplete,
  withClaudeAccountItRuns,
} from "@archestra/shared";
import config from "@/config";
import {
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  TeamModel,
} from "@/models";
import { CredentialAccess } from "@/services/credential-access";
import type {
  Agent,
  AgentRuntime,
  AgentType,
  ResolvedAgentRuntime,
} from "@/types";
import { ApiError, OWN_ACCOUNT_ONLY } from "@/types";
import { checkCompanyConnection } from "./account-resolution";
import { isAnyAgentRuntimeBackendDriverEnabled } from "./backends";
import { getResolvedAgentRuntimeModelCompatibility } from "./model-compatibility";
import { organizationAgentRuntimeTiers } from "./runtime-tiers";

// Checks every surface that writes an Agent's runtime or model must run. The
// agents REST routes and the create_agent/edit_agent MCP tools both call these,
// so neither can store a runtime or model pairing the other would refuse.

/**
 * Whether a runtime may run here at all: the cluster has a runtime backend,
 * the agent is an Agent, and privileged mode is allowed. Who may use which
 * Agent Runtime is `applyAgentRuntimeAccess`'s question.
 */
export async function requireAgentRuntimePermission(params: {
  agentType: AgentType;
  runtime?: AgentRuntime | null;
  isAdmin: boolean;
}): Promise<void> {
  if (params.runtime == null) return;
  if (!isAnyAgentRuntimeBackendDriverEnabled()) {
    throw new ApiError(
      400,
      "Agent Runtime is unavailable: this cluster does not have the Agent Sandbox controller installed",
    );
  }
  if (params.agentType !== "agent") {
    throw new ApiError(400, "Agent Runtime can only be configured for Agents");
  }
  if (params.runtime.privileged && !params.isAdmin) {
    throw new ApiError(
      403,
      "Only Agent administrators can enable a privileged background deployment",
    );
  }
  if (params.runtime.privileged && !config.agentRuntime.allowPrivileged) {
    throw new ApiError(
      403,
      "Privileged background deployments are disabled by the deployment operator",
    );
  }
}

/**
 * Refuse a runtime whose default or scaleup tier is not one of the
 * organization's tiers, naming the tiers it has.
 */
export async function assertAgentRuntimeTiersExist(params: {
  runtime: Pick<AgentRuntime, "tier" | "maxTier"> | null | undefined;
  organizationId: string;
}): Promise<void> {
  if (!params.runtime) return;
  const { tiers } = await organizationAgentRuntimeTiers(params.organizationId);
  for (const [label, name] of [
    ["default tier", params.runtime.tier],
    ["scaleup tier", params.runtime.maxTier],
  ] as const) {
    if (name && !findAgentRuntimeTier(tiers, name)) {
      throw new ApiError(
        400,
        `The ${label} ${name} is not one of the organization's runtime tiers: ${tiers.map((tier) => tier.name).join(", ")}`,
      );
    }
  }
}

/**
 * Refuse a runtime that newly reads a saved credential the caller may not use:
 * the Agent's runs would hand its value to whatever they execute. `previous`
 * is the stored runtime on an edit, so credentials it already read stay put.
 */
export async function assertCanBindRuntimeCredentials(params: {
  organizationId: string;
  userId: string;
  previous: AgentRuntime | null | undefined;
  next: AgentRuntime | null | undefined;
}): Promise<void> {
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  if (params.next == null) return;
  await CredentialAccess.requireUseOfNewKeys({
    organizationId: params.organizationId,
    userId: params.userId,
    previous: runtimeCredentialKeys(params.previous),
    next: runtimeCredentialKeys(params.next),
  });
  // SPDX-SnippetEnd
}

/**
 * Whether a save may store this model and key together: both or neither.
 * An Agent Runtime agent may also store its connection alone, which leaves
 * the model to each person who runs it; and, on a runtime that fixes its
 * agents' connection, a model alone, which runs on that connection. A save
 * never stores a model with no connection at either level. A copy can hold
 * one, since it keeps its source's model without the source's key: on a
 * runtime agent that sets no connection, such a model sets nothing.
 */
export function canStoreAgentModelSelection(params: {
  modelId: string | null | undefined;
  llmApiKeyId: string | null | undefined;
  /** The runtime the agent has once the write is stored, if any. */
  runtime: AgentRuntime | null | undefined;
  runtimeConnection: { llmApiKeyId: string } | null;
}): boolean {
  return (
    isModelSelectionComplete({
      modelId: params.modelId,
      apiKeyId: params.llmApiKeyId,
    }) ||
    (!!params.runtime && !!params.llmApiKeyId && !params.modelId) ||
    (!!params.runtimeConnection && !!params.modelId && !params.llmApiKeyId)
  );
}

/**
 * The model and connection a write's model is judged on: what it sends,
 * with what the agent stores for the rest. On a runtime that fixes its
 * agents' connection, a model sent without a connection runs on that
 * connection, whatever connection the agent kept from before: it is judged
 * as a model alone, and the agent keeps its connection.
 */
export function agentPairToCheck(params: {
  sent: { llmApiKeyId?: string | null; modelId?: string | null };
  stored: Pick<Agent, "llmApiKeyId" | "modelId"> | null | undefined;
  runtimeConnection: { llmApiKeyId: string } | null | undefined;
}): Pick<Agent, "llmApiKeyId" | "modelId"> {
  const { sent, stored } = params;
  const modelId =
    sent.modelId !== undefined ? sent.modelId : (stored?.modelId ?? null);
  const llmApiKeyId =
    sent.llmApiKeyId !== undefined
      ? sent.llmApiKeyId
      : params.runtimeConnection && sent.modelId
        ? null
        : (stored?.llmApiKeyId ?? null);
  return { llmApiKeyId, modelId };
}

/**
 * Refuse a model/key pair the caller cannot use, or a half-set pair an
 * agent may not store. An Agent Runtime agent may store its connection
 * alone, which must be one the caller may use; its model is then each
 * person's to pick. On a runtime that fixes its agents' connection, an
 * agent may store a model alone, which must be one of that connection's
 * models and run on the runtime. Answers whether that is the case, since
 * the model then runs on the runtime's connection, not on a key of the
 * agent's.
 */
export async function assertAgentModelSelectionAvailable(params: {
  agent: Pick<Agent, "llmApiKeyId" | "modelId">;
  organizationId: string;
  userId: string;
  /** The agent's runtime and the connection it fixes, when it fixes one. */
  runtime?: Pick<
    AgentRuntime,
    "command" | "inferenceProtocol" | "claudeCode"
  > | null;
  runtimeConnection?: { llmApiKeyId: string; runtimeName: string } | null;
}): Promise<{ onRuntimeConnection: boolean }> {
  const { llmApiKeyId, modelId } = params.agent;
  // What a runtime agent's company account is called: a plan on the
  // Copilot CLI, an API key everywhere else.
  const key = companyAccountWords(params.runtime?.command?.[0]).plan
    ? "plan"
    : "API key";
  if (!llmApiKeyId && !modelId) return { onRuntimeConnection: false };
  if (!llmApiKeyId && modelId && params.runtime && params.runtimeConnection) {
    await assertModelOfRuntimeConnection({
      organizationId: params.organizationId,
      runtime: params.runtime,
      runtimeConnection: params.runtimeConnection,
      modelId,
    });
    return { onRuntimeConnection: true };
  }
  if (!llmApiKeyId || (!modelId && !params.runtime)) {
    throw new ApiError(400, `An agent's model and ${key} must be set together`);
  }
  const userTeamIds = await TeamModel.getUserTeamIds(params.userId);
  const availableKeys = await LlmProviderApiKeyModel.getAvailableKeysForUser(
    params.organizationId,
    params.userId,
    userTeamIds,
  );
  const selectedKey = availableKeys.find((key) => key.id === llmApiKeyId);
  if (!modelId) {
    if (!selectedKey) {
      throw new ApiError(400, `The selected ${key} must be available to you`);
    }
    return { onRuntimeConnection: false };
  }
  const selectedModelIsLinked = selectedKey
    ? (
        await LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds([
          selectedKey.id,
        ])
      ).some(({ model }) => model.id === modelId)
    : false;
  if (!selectedModelIsLinked) {
    throw new ApiError(
      400,
      `The selected model and ${key} must be linked and available to you`,
    );
  }
  return { onRuntimeConnection: false };
}

export async function assertAgentRuntimeModelCompatibility(params: {
  runtime:
    | (Pick<
        AgentRuntime,
        "image" | "command" | "inferenceProtocol" | "claudeCode"
      > & {
        accountLock?: ResolvedAgentRuntime["accountLock"];
      })
    | null
    | undefined;
  agent: Pick<Agent, "llmApiKeyId" | "modelId">;
  organizationId: string;
  userId: string;
  /**
   * Whether this write picks the agent's model or key. A write that only
   * changes the runtime keeps the pair the agent already has, so the caller
   * need not be able to use that key themselves; the runtime is still checked
   * against that pair, as the agent's runs use it.
   */
  selectsModel: boolean;
  /** See `assertAgentModelSelectionAvailable`. */
  runtimeConnection?: { llmApiKeyId: string; runtimeName: string } | null;
}): Promise<void> {
  const { runtime } = params;
  if (!runtime) return;
  if (params.selectsModel) {
    const { onRuntimeConnection } = await assertAgentModelSelectionAvailable({
      ...params,
      runtime,
    });
    // Checked against the runtime's connection, on which it runs.
    if (onRuntimeConnection) return;
  }
  // An agent saved before people could choose its account runs only the
  // way its own settings say, as it always did.
  const savedBeforeChoosing =
    runtime.accountLock === undefined ||
    runtime.accountLock === OWN_ACCOUNT_ONLY;
  // A connection without a model leaves the model to each person: there is
  // none to judge yet, and the organization's default plays no part. The
  // connection itself must hold an API key that the runtime can run on. On
  // an agent saved before people could choose, such a connection plays no
  // part in its runs, which take the organization's default: that is judged
  // below instead.
  if (
    params.agent.llmApiKeyId &&
    !params.agent.modelId &&
    !savedBeforeChoosing
  ) {
    await assertConnectionRunsOnRuntime({
      organizationId: params.organizationId,
      runtime,
      llmApiKeyId: params.agent.llmApiKeyId,
    });
    return;
  }
  const result = await getResolvedAgentRuntimeModelCompatibility({
    ...params,
    // A runtime that names no lock runs on the Claude account it always ran
    // on.
    runtime: {
      ...withClaudeAccountItRuns({ runtime, savedBeforeChoosing }),
      accountLock:
        runtime.accountLock === undefined
          ? OWN_ACCOUNT_ONLY
          : runtime.accountLock,
    },
    asStored: !params.selectsModel,
    // A write is checked for what it stores on the agent.
    withoutRuntimeRule: true,
  });
  if (!result.compatibility.compatible) {
    throw new ApiError(409, result.compatibility.message);
  }
}

/**
 * The model an agent sets for each company connection it leaves to each
 * person. Every pair the write adds or changes must be a connection the
 * caller may use with one of its models, by the checks any company
 * connection passes. There is nothing to set them for where the agent or
 * its runtime sets the connection. A pair the write keeps was checked when
 * it was saved: one whose model or connection was deleted since plays no
 * part in any run, and does not hold a save back.
 */
export async function assertAgentConnectionModels(params: {
  runtime:
    | Pick<
        AgentRuntime,
        "command" | "inferenceProtocol" | "claudeCode" | "connectionModels"
      >
    | null
    | undefined;
  previous?: Pick<AgentRuntime, "connectionModels"> | null;
  agent: Pick<Agent, "llmApiKeyId">;
  runtimeConnection?: { llmApiKeyId: string } | null;
  organizationId: string;
  userId: string;
}): Promise<void> {
  const { runtime } = params;
  const previous = params.previous?.connectionModels ?? {};
  const entries = Object.entries(runtime?.connectionModels ?? {}).filter(
    ([llmApiKeyId, modelId]) => previous[llmApiKeyId] !== modelId,
  );
  if (!runtime || entries.length === 0) return;
  const words = companyAccountWords(runtime.command?.[0]);
  if (params.agent.llmApiKeyId || params.runtimeConnection) {
    throw new ApiError(
      400,
      `A model is set for each ${words.connection} only where the ${words.connection} is left to each person.`,
    );
  }
  const usable = new Set(
    (
      await LlmProviderApiKeyModel.getAvailableKeysForUser(
        params.organizationId,
        params.userId,
        [],
      )
    ).map(({ id }) => id),
  );
  for (const [llmApiKeyId, modelId] of entries) {
    if (!usable.has(llmApiKeyId)) {
      throw new ApiError(
        400,
        `The selected ${words.plan ? "plan" : "API key"} must be available to you`,
      );
    }
    const checked = await checkCompanyConnection({
      runtime,
      organizationId: params.organizationId,
      llmApiKeyId,
      modelId,
    });
    if (!("problem" in checked)) continue;
    if (checked.problem === "incompatible") {
      throw new ApiError(409, checked.message);
    }
    throw new ApiError(
      400,
      checked.problem === "model"
        ? `The model set for a ${words.connection} must be one of its models.`
        : checked.problem === "personal"
          ? `A model can be set only for ${words.a}, not for a personal subscription.`
          : `The selected ${words.connection} does not exist in this organization.`,
    );
  }
}

/**
 * A model an agent stores without a connection runs on the connection its
 * runtime fixes: it must be one of that connection's models and run on the
 * runtime, by the checks any company connection passes.
 */
async function assertModelOfRuntimeConnection(params: {
  organizationId: string;
  runtime: Pick<AgentRuntime, "command" | "inferenceProtocol" | "claudeCode">;
  runtimeConnection: { llmApiKeyId: string; runtimeName: string };
  modelId: string;
}): Promise<void> {
  const { runtimeName, llmApiKeyId } = params.runtimeConnection;
  const { connection } = companyAccountWords(params.runtime.command?.[0]);
  const checked = await checkCompanyConnection({
    runtime: params.runtime,
    organizationId: params.organizationId,
    llmApiKeyId,
    modelId: params.modelId,
  });
  if (!("problem" in checked)) return;
  if (checked.problem === "incompatible") {
    throw new ApiError(409, checked.message);
  }
  throw new ApiError(
    checked.problem === "model" ? 400 : 409,
    checked.problem === "model"
      ? `The ${runtimeName} runtime runs its agents on one ${connection}, and the model you chose is not one of its models. Choose one of them.`
      : `The ${connection} the ${runtimeName} runtime runs its agents on no longer works. Someone who can configure the runtime must choose another.`,
  );
}

/**
 * A connection an agent stores without a model is the company API key every
 * person's runs use, each with a model they pick: it must hold an API key,
 * not someone's subscription, and serve the runtime.
 */
async function assertConnectionRunsOnRuntime(params: {
  organizationId: string;
  runtime: Pick<AgentRuntime, "command" | "inferenceProtocol" | "claudeCode">;
  llmApiKeyId: string;
}): Promise<void> {
  const checked = await checkCompanyConnection({ ...params, modelId: null });
  if (!("problem" in checked)) return;
  if (checked.problem === "incompatible") {
    throw new ApiError(409, checked.message);
  }
  if (companyAccountWords(params.runtime.command?.[0]).plan) {
    throw new ApiError(
      400,
      checked.problem === "personal"
        ? "A plan set without a model must be the company's enterprise plan, not a personal subscription. Choose its model too, or an enterprise plan."
        : "The selected plan does not exist in this organization.",
    );
  }
  throw new ApiError(
    400,
    checked.problem === "personal"
      ? "An API key set without a model must be a company API key, not a personal subscription. Choose its model too, or another API key."
      : "The selected API key does not exist in this organization.",
  );
}

function runtimeCredentialKeys(runtime: AgentRuntime | null | undefined) {
  return (runtime?.credentials ?? []).flatMap((declaration) =>
    declaration.credentialId ? [declaration.credentialId] : [],
  );
}
