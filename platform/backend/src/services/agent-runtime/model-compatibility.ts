import {
  DEFAULT_CLAUDE_CODE_MODEL,
  getAgentRuntimeDefaultModelCompatibility,
  getAgentRuntimeModelCompatibility,
  isClaudeCodeRuntimeCommand,
  type SupportedProvider,
} from "@archestra/shared";
import { getAgentTypePermissionChecker } from "@/auth/agent-type-permissions";
import { hiddenAgentsAmong } from "@/auth/permission-gated";
import config from "@/config";
import {
  AgentModel,
  AgentTeamModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
} from "@/models";
import type { Agent, Model, ResolvedAgentRuntime } from "@/types";
import { ApiError } from "@/types";
import {
  type ConversationLlmSelection,
  resolveConversationLlmSelectionForAgent,
} from "@/utils/llm-resolution";

/**
 * Resolve the model an Agent Runtime run would receive and reject an image
 * protocol that cannot serve it. This only reads model configuration, so task
 * callers can use it before creating a detached task.
 */
export async function preflightAgentRuntimeModelCompatibility(params: {
  runtime: Pick<
    ResolvedAgentRuntime,
    "command" | "inferenceProtocol" | "claudeCode"
  >;
  agent: Pick<Agent, "llmApiKeyId" | "modelId">;
  organizationId: string;
  userId: string;
}) {
  const result = await getResolvedAgentRuntimeModelCompatibility(params);
  if (!result.compatibility.compatible) {
    throw new ApiError(409, result.compatibility.message);
  }
  return result;
}

export async function getResolvedAgentRuntimeModelCompatibility(params: {
  runtime: Pick<
    ResolvedAgentRuntime,
    "command" | "inferenceProtocol" | "claudeCode"
  >;
  agent: Pick<Agent, "llmApiKeyId" | "modelId">;
  organizationId: string;
  userId: string;
  /**
   * Check the runtime against the model and key the agent stores, as its runs
   * use them, instead of against what `userId` may use. For a write that keeps
   * the agent's pair, the caller's own keys do not matter: a release that
   * moves an agent to a new image is not choosing its model.
   */
  asStored?: boolean;
}) {
  let llm: ConversationLlmSelection =
    isClaudeCodeRuntimeCommand(params.runtime.command?.[0]) &&
    params.runtime.claudeCode?.authentication === "subscription"
      ? {
          modelId: null,
          chatApiKeyId: null,
          selectedModel:
            params.runtime.claudeCode.model ?? DEFAULT_CLAUDE_CODE_MODEL,
          selectedProvider: "anthropic" as const,
        }
      : ((params.asStored ? await storedAgentLlmSelection(params) : null) ??
        (await resolveConversationLlmSelectionForAgent({
          agent: params.agent,
          organizationId: params.organizationId,
          userId: params.userId,
        })));
  const usesClaudeCodeSubscription =
    isClaudeCodeRuntimeCommand(params.runtime.command?.[0]) &&
    params.runtime.claudeCode?.authentication !== "provider" &&
    !getClaudeCodeCloudProvider({
      runtime: params.runtime,
      provider: llm.selectedProvider,
    });
  if (usesClaudeCodeSubscription) {
    llm = {
      modelId: null,
      chatApiKeyId: null,
      selectedProvider: "anthropic",
      selectedModel:
        params.runtime.claudeCode?.model ?? DEFAULT_CLAUDE_CODE_MODEL,
    };
  }
  const selectedModel = llm.modelId
    ? await ModelModel.findById(llm.modelId)
    : null;
  const compatibility = getAgentRuntimeModelCompatibility({
    inferenceProtocol: params.runtime.inferenceProtocol,
    runtimeCommand: params.runtime.command,
    provider: llm.selectedProvider,
    modelId: llm.selectedModel,
    supportedEndpoints: selectedModel?.supportedEndpoints,
  });

  return { compatibility, llm, selectedModel, usesClaudeCodeSubscription };
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

/** Cloud-hosted Claude uses provider billing instead of a Claude subscription. */
export function getClaudeCodeCloudProvider(params: {
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
  for (const row of rows) {
    const runtime: RuntimeDependent = {
      runtimeCommand: row.runtime.command ?? null,
      inferenceProtocol: row.runtime.inferenceProtocol,
      ...(row.runtime.claudeCode && {
        claudeCodeAuthentication: row.runtime.claudeCode.authentication,
      }),
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
 * agent (gated agents, per-type permissions, and team visibility for anyone
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
  const [checker, gatedHidden, teamVisible] = await Promise.all([
    getAgentTypePermissionChecker(params),
    hiddenAgentsAmong(
      params.agents.map((agent) => agent.id),
      {
        kind: "caller",
        userId: params.userId,
        organizationId: params.organizationId,
      },
    ),
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
      !gatedHidden.has(agent.id) &&
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
