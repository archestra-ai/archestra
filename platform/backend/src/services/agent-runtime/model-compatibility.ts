import {
  getAgentRuntimeModelCompatibility,
  type SupportedProvider,
} from "@archestra/shared";
import config from "@/config";
import { ModelModel } from "@/models";
import type { Agent, ResolvedAgentRuntime } from "@/types";
import { ApiError } from "@/types";
import { resolveConversationLlmSelectionForAgent } from "@/utils/llm-resolution";

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
}) {
  let llm =
    params.runtime.command?.[0] === "archestra-claude-code" &&
    params.runtime.claudeCode?.authentication === "subscription"
      ? {
          modelId: null,
          chatApiKeyId: null,
          selectedModel: params.runtime.claudeCode.model ?? "default",
          selectedProvider: "anthropic" as const,
        }
      : await resolveConversationLlmSelectionForAgent({
          agent: params.agent,
          organizationId: params.organizationId,
          userId: params.userId,
          includeMemberChatDefault: false,
        });
  const usesClaudeCodeSubscription =
    params.runtime.command?.[0] === "archestra-claude-code" &&
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
      selectedModel: params.runtime.claudeCode?.model ?? "default",
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

/** Cloud-hosted Claude uses provider billing instead of a Claude subscription. */
export function getClaudeCodeCloudProvider(params: {
  runtime: Partial<Pick<ResolvedAgentRuntime, "command" | "claudeCode">>;
  provider: SupportedProvider;
}): "bedrock" | "vertex" | null {
  if (params.runtime.command?.[0] !== "archestra-claude-code") return null;
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
