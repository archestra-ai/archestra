import type { Anthropic, OpenAi } from "@/types";
import * as anthropic from "./anthropic";
import * as openai from "./openai";

type OpenAiMessages = OpenAi.Types.ChatCompletionsRequest["messages"];
type AnthropicMessages = Anthropic.Types.MessagesRequest["messages"];

type OpenAiParams = {
  provider: "openai";
  messages: OpenAiMessages;
};
type AnthropicParams = {
  provider: "anthropic";
  messages: AnthropicMessages;
};

/**
 * Evaluate if context is trusted based on provider-specific message formats
 * Uses discriminated union to ensure type safety across OpenAI and Anthropic providers
 */
export async function evaluateIfContextIsTrusted(
  params: AnthropicParams,
  agentId: string,
  apiKey: string,
): Promise<{
  filteredMessages: AnthropicMessages;
  contextIsTrusted: boolean;
}>;
export async function evaluateIfContextIsTrusted(
  params: OpenAiParams,
  agentId: string,
  apiKey: string,
): Promise<{
  filteredMessages: OpenAiMessages;
  contextIsTrusted: boolean;
}>;
export async function evaluateIfContextIsTrusted(
  params: AnthropicParams | OpenAiParams,
  agentId: string,
  apiKey: string,
): Promise<{
  filteredMessages: AnthropicMessages | OpenAiMessages;
  contextIsTrusted: boolean;
}> {
  if (params.provider === "anthropic") {
    return anthropic.evaluateIfContextIsTrusted(
      params.messages,
      agentId,
      apiKey,
    );
  }
  return openai.evaluateIfContextIsTrusted(params.messages, agentId, apiKey);
}
