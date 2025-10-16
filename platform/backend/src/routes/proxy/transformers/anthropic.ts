import { randomUUID } from "node:crypto";
import type { Anthropic, OpenAi } from "@/types";
import type { ProviderTransformer } from "./common";

/**
 * Converts between Anthropic's messages format and OpenAI's chatCompletions format
 */
export class AnthropicMessagesTransformer
  implements
    ProviderTransformer<
      Anthropic.Types.MessagesRequest,
      Anthropic.Types.MessagesResponse
    >
{
  provider = "anthropic:messages" as const;

  requestToOpenAI(
    request: Anthropic.Types.MessagesRequest,
  ): OpenAi.Types.ChatCompletionsRequest {
    const openAiTools: OpenAi.Types.ChatCompletionsRequest["tools"] = [];
    const openAiMessages: OpenAi.Types.ChatCompletionsRequest["messages"] = [];

    for (const tool of request.tools || []) {
      if (tool.type === "custom") {
        openAiTools.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description || "",
            parameters: tool.input_schema as any,
          },
        });
      }
    }

    for (const message of request.messages) {
      if (message.role === "user") {
        openAiMessages.push({
          role: "user",
          content: message.content,
        });
      } else if (message.role === "assistant") {
        openAiMessages.push({
          role: "assistant",
          content: message.content,
        });
      }
    }

    return {
      model: request.model,
      messages: openAiMessages,
      tools: openAiTools,
      stream: request.stream ?? false,
      temperature: request.temperature ?? 0,
      tool_choice: request.tool_choice ?? "none",
    };
  }

  requestFromOpenAI(
    request: OpenAi.Types.ChatCompletionsRequest,
  ): Anthropic.Types.MessagesRequest {
    const anthropicTools: Anthropic.Types.MessagesRequest["tools"] = [];
    const anthropicMessages: Anthropic.Types.MessagesRequest["messages"] = [];

    for (const tool of request.tools || []) {
      if (tool.type === "function") {
        anthropicTools.push({
          name: tool.function.name,
          input_schema: tool.function.parameters as any,
        });
      }
    }

    for (const message of request.messages) {
      if (message.role === "user") {
        anthropicMessages.push({
          role: "user",
          content: message.content,
        });
      } else if (message.role === "assistant") {
        anthropicMessages.push({
          role: "assistant",
          content: message.content as any,
        });
      }
    }

    return {
      model: request.model,
      messages: anthropicMessages,
      tools: anthropicTools,
      stream: request.stream ?? false,
      temperature: request.temperature ?? 0,
      tool_choice: request.tool_choice ?? "none",
      max_tokens: request.max_tokens ?? 0,
    };
  }

  chunkToOpenAI(
    chunk: Anthropic.Types.MessagesResponse,
  ): OpenAi.Types.ChatCompletionChunk {
    return {
      id: `chatcmpl-${randomUUID().replace(/-/g, "").substring(0, 29)}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: chunk.model,
      choices: [],
    };
  }
}
