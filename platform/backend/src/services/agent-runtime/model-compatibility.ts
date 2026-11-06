import {
  DEFAULT_CLAUDE_CODE_MODEL,
  getAgentRuntimeModelCompatibility,
  isClaudeCodeRuntimeCommand,
  type SupportedProvider,
} from "@archestra/shared";
import config from "@/config";
import {
  AgentModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
} from "@/models";
import type { Agent, ResolvedAgentRuntime } from "@/types";
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
 * Agent Runtime agents with no model or key of their own: they run on the
 * organization's default model, so a new default must suit their runtimes.
 */
export async function listRuntimeAgentsInheritingOrganizationDefault(
  organizationId: string,
): Promise<
  Array<{
    id: string;
    name: string;
    runtimeCommand: string[] | null;
    inferenceProtocol: NonNullable<Agent["runtime"]>["inferenceProtocol"];
  }>
> {
  const agents =
    await AgentModel.findRuntimeAgentsInheritingOrganizationDefault(
      organizationId,
    );
  return agents.flatMap((agent) =>
    agent.runtime
      ? [
          {
            id: agent.id,
            name: agent.name,
            runtimeCommand: agent.runtime.command ?? null,
            inferenceProtocol: agent.runtime.inferenceProtocol,
          },
        ]
      : [],
  );
}

/** Rejects an organization default model an inheriting Agent Runtime agent cannot run. */
export async function assertRuntimeAgentsSupportOrganizationDefault(params: {
  organizationId: string;
  modelId: string | null;
}): Promise<void> {
  if (!params.modelId) return;
  const [model, agents] = await Promise.all([
    ModelModel.findById(params.modelId),
    listRuntimeAgentsInheritingOrganizationDefault(params.organizationId),
  ]);
  if (!model) {
    throw new ApiError(404, "Default model not found");
  }
  const incompatible = agents.flatMap((agent) => {
    const result = getAgentRuntimeModelCompatibility({
      inferenceProtocol: agent.inferenceProtocol,
      runtimeCommand: agent.runtimeCommand,
      provider: model.provider,
      modelId: model.modelId,
      supportedEndpoints: model.supportedEndpoints,
    });
    return result.compatible ? [] : [{ agent, reason: result.message }];
  });
  if (incompatible.length === 0) return;
  const names = incompatible.map(({ agent }) => `"${agent.name}"`);
  const listed =
    names.length > 3
      ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`
      : names.join(", ");
  const subject =
    incompatible.length === 1
      ? `Agent Runtime agent ${listed} has no model of its own, so it`
      : `Agent Runtime agents ${listed} have no model of their own, so they`;
  throw new ApiError(
    409,
    `Can't use "${model.modelId}" as the default model. ${subject} would run on it, and it can't: ${incompatible[0].reason} Set a model on ${incompatible.length === 1 ? "that agent" : "those agents"}, or choose a compatible default model.`,
  );
}
