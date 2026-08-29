import {
  type SupportedProvider,
  type TitleRejectionReason,
  toConversationTitle,
  truncateChars,
} from "@archestra/shared";
import { generateText } from "ai";
import { createLLMModel } from "@/clients/llm-client";
import logger from "@/logging";

interface GenerateTitleParams {
  provider: SupportedProvider;
  apiKey: string | undefined;
  modelName: string;
  baseUrl: string | null;
  chatApiKeyId?: string;
  agentId: string;
  userId: string;
  sessionId: string;
  systemPrompt: string;
  firstUserMessage: string;
  firstAssistantMessage: string;
}

/**
 * Build the bounded prompt shared by Chat and execution-session titles.
 * @public — exported for focused prompt-boundary tests.
 */
export function buildTitlePrompt(
  firstUserMessage: string,
  firstAssistantMessage: string,
): string {
  const user = truncateChars(firstUserMessage, TITLE_PROMPT_EXCERPT_MAX_CHARS);
  const assistant = truncateChars(
    firstAssistantMessage,
    TITLE_PROMPT_EXCERPT_MAX_CHARS,
  );
  const contextMessages = assistant
    ? `User: ${user}\n\nAssistant: ${assistant}`
    : `User: ${user}`;
  return `Chat conversation messages:\n\n${contextMessages}`;
}

/** Generate one concise title through Chat's logged internal-LLM path. */
export async function generateConversationTitle(
  params: GenerateTitleParams,
): Promise<string | null> {
  const titlePrompt = buildTitlePrompt(
    params.firstUserMessage,
    params.firstAssistantMessage,
  );
  const model = createLLMModel({
    provider: params.provider,
    apiKey: params.apiKey,
    agentId: params.agentId,
    modelName: params.modelName,
    userId: params.userId,
    sessionId: params.sessionId,
    source: "chat:title_generation",
    baseUrl: params.baseUrl,
    chatApiKeyId: params.chatApiKeyId,
  });

  try {
    const result = await generateText({
      model,
      system: params.systemPrompt,
      prompt: titlePrompt,
      maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
    });
    const outcome = toConversationTitle(result.text);
    if (outcome.title === null) {
      logger.warn(
        {
          provider: params.provider,
          modelName: params.modelName,
          sessionId: params.sessionId,
          rejectionReason: outcome.reason,
          finishReason: result.finishReason,
          responseChars: result.text.length,
        },
        TITLE_REJECTION_MESSAGES[outcome.reason],
      );
      return null;
    }
    return outcome.title;
  } catch (error) {
    logger.error(
      {
        error,
        provider: params.provider,
        modelName: params.modelName,
        baseUrl: params.baseUrl,
        sessionId: params.sessionId,
      },
      "Title generation failed; keeping the opening words as the title",
    );
    return null;
  }
}

const TITLE_MAX_OUTPUT_TOKENS = 4096;
const TITLE_PROMPT_EXCERPT_MAX_CHARS = 1000;
const TITLE_REJECTION_MESSAGES: Record<TitleRejectionReason, string> = {
  empty_response:
    "Title generation produced no visible text; keeping the opening words as the title",
  not_a_title:
    "Title generation returned an answer instead of a concise title; keeping the opening words as the title",
};
