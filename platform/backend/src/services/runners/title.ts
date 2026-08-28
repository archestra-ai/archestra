import {
  BUILT_IN_AGENT_IDS,
  CHAT_TITLE_GENERATION_SYSTEM_PROMPT,
  toPlaceholderTitle,
} from "@archestra/shared";
import { isApiKeyRequired } from "@/clients/llm-client";
import { AgentModel } from "@/models";
import { generateConversationTitle } from "@/services/title-generation";
import { renderSystemPrompt } from "@/templating";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";

/** Generate an execution title without delaying pod startup. */
export async function generateAgentExecutionTitle(params: {
  taskId: string;
  prompt: string;
  organizationId: string;
  userId?: string;
  modelId: string | null;
  llmApiKeyId: string | null;
}): Promise<string> {
  const fallback = toPlaceholderTitle(params.prompt);
  const titleAgent = await AgentModel.getBuiltInAgent(
    BUILT_IN_AGENT_IDS.CHAT_TITLE_GENERATION,
    params.organizationId,
  );
  const titleLlm = await resolveAgentLlmOrDefault({
    agent: titleAgent,
    inheritFrom: {
      modelId: params.modelId,
      agentLlmApiKeyId: params.llmApiKeyId,
    },
    organizationId: params.organizationId,
    userId: params.userId,
    conversationId: params.taskId,
  });
  if (
    isApiKeyRequired(titleLlm.provider, titleLlm.apiKey) ||
    titleLlm.provider === "microsoft-365-copilot"
  ) {
    return fallback;
  }
  const systemPrompt =
    renderSystemPrompt(
      titleAgent?.systemPrompt ?? CHAT_TITLE_GENERATION_SYSTEM_PROMPT,
    ) ?? CHAT_TITLE_GENERATION_SYSTEM_PROMPT;
  return (
    (await generateConversationTitle({
      ...titleLlm,
      agentId: titleAgent?.id ?? params.taskId,
      userId: params.userId ?? "system",
      sessionId: params.taskId,
      systemPrompt,
      firstUserMessage: params.prompt,
      firstAssistantMessage: "",
    })) ?? fallback
  );
}
