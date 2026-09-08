import {
  MODEL_ROUTER_SUPPORTED_PROVIDERS,
  providerDisplayNames,
  requiresOpenAiResponsesApi,
  requiresResponsesApi,
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
  runtime: Pick<ResolvedAgentRuntime, "inferenceProtocol"> &
    Partial<Pick<ResolvedAgentRuntime, "command">>;
  agent: Pick<Agent, "llmApiKeyId" | "modelId">;
  organizationId: string;
  userId: string;
}) {
  const llm = await resolveConversationLlmSelectionForAgent({
    agent: params.agent,
    organizationId: params.organizationId,
    userId: params.userId,
    includeMemberChatDefault: false,
  });
  const selectedModel = llm.modelId
    ? await ModelModel.findById(llm.modelId)
    : null;
  assertInferenceProtocolSupported({
    protocol: params.runtime.inferenceProtocol,
    command: params.runtime.command,
    provider: llm.selectedProvider,
    model: llm.selectedModel,
    supportedEndpoints: selectedModel?.supportedEndpoints,
  });

  return { llm, selectedModel };
}

/** Cloud-hosted Claude uses provider billing instead of a Claude subscription. */
export function getClaudeCodeCloudProvider(params: {
  runtime: Partial<Pick<ResolvedAgentRuntime, "command">>;
  provider: SupportedProvider;
}): "bedrock" | "vertex" | null {
  if (params.runtime.command?.[0] !== "archestra-claude-code") return null;
  if (params.provider === "bedrock") return "bedrock";
  if (
    params.provider === "anthropic" &&
    config.llm.anthropic.vertexAi.enabled
  ) {
    return "vertex";
  }
  return null;
}

function assertInferenceProtocolSupported(params: {
  protocol: ResolvedAgentRuntime["inferenceProtocol"];
  command: ResolvedAgentRuntime["command"] | undefined;
  provider: SupportedProvider;
  model: string;
  supportedEndpoints: string[] | null | undefined;
}): void {
  const claudeCodeBedrock =
    getClaudeCodeCloudProvider({
      runtime: { command: params.command },
      provider: params.provider,
    }) === "bedrock";
  if (claudeCodeBedrock && !/(?:^|[./])anthropic\.claude-/.test(params.model)) {
    throw new ApiError(
      409,
      "The Claude Code runtime requires a Claude model when using AWS Bedrock.",
    );
  }
  if (
    params.protocol === "anthropic" &&
    params.provider !== "anthropic" &&
    !claudeCodeBedrock
  ) {
    throw new ApiError(
      409,
      `This Agent Runtime image expects the Anthropic API, but the Agent's selected model uses ${providerDisplayNames[params.provider]}. Choose an Anthropic model or use an OpenAI-compatible Agent Runtime image.`,
    );
  }
  if (
    params.protocol !== "anthropic" &&
    !new Set<SupportedProvider>(MODEL_ROUTER_SUPPORTED_PROVIDERS).has(
      params.provider,
    )
  ) {
    throw new ApiError(
      409,
      `${providerDisplayNames[params.provider]} models are not available through the OpenAI-compatible model router used by this Agent Runtime image.`,
    );
  }
  if (
    params.protocol === "openai_chat" &&
    (requiresResponsesApi(params.supportedEndpoints) ||
      (params.provider === "openai" &&
        requiresOpenAiResponsesApi(params.model)))
  ) {
    throw new ApiError(
      409,
      `This Agent Runtime image uses Chat Completions, but model "${params.model}" requires the Responses API. Choose a Chat Completions model or an image that uses OpenAI Responses.`,
    );
  }
}
