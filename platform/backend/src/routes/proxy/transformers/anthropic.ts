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

    if (request.system) {
      openAiMessages.push({
        role: "system",
        content:
          typeof request.system === "string"
            ? request.system
            : request.system.text,
      });
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

    const openAiRequest: OpenAi.Types.ChatCompletionsRequest = {
      model: request.model,
      messages: openAiMessages,
      tools: openAiTools,
      stream: request.stream ?? false,
      temperature: request.temperature ?? 0,
      max_tokens: request.max_tokens,
    };

    if (request.tool_choice) {
      switch (request.tool_choice.type) {
        case "any":
        case "tool":
        case "auto":
          openAiRequest.tool_choice = "auto";
          break;
        case "none":
          openAiRequest.tool_choice = "none";
          break;
      }
    }

    return openAiRequest;
  }

  requestFromOpenAI(
    request: OpenAi.Types.ChatCompletionsRequest,
  ): Anthropic.Types.MessagesRequest {
    const anthropicRequest: Anthropic.Types.MessagesRequest = {
      model: request.model,
      messages: [],
      tools: [],
      stream: request.stream ?? false,
      temperature: request.temperature ?? 0,
      max_tokens: request.max_tokens ?? 100_000, // NOTE: what to set this to?
    };

    for (const tool of request.tools || []) {
      if (tool.type === "function") {
        anthropicRequest.tools?.push({
          name: tool.function.name,
          input_schema: tool.function.parameters as any,
        });
      }
    }

    for (const message of request.messages) {
      if (message.role === "system") {
        anthropicRequest.system =
          typeof message.content === "string"
            ? message.content
            : message.content[0].text;
      } else if (message.role === "user") {
        anthropicRequest.messages?.push({
          role: "user",
          content: message.content,
        });
      } else if (message.role === "assistant") {
        anthropicRequest.messages?.push({
          role: "assistant",
          content: message.content as any,
        });
      }
    }

    if (request.tool_choice) {
      switch (request.tool_choice) {
        case "required":
        case "auto":
          anthropicRequest.tool_choice = {
            type: "auto",
          };
          break;
        case "none":
          anthropicRequest.tool_choice = {
            type: "none",
          };
          break;
      }
    }

    return anthropicRequest;
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
