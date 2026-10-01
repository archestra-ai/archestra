import { randomUUID } from "node:crypto";
import { ApiError } from "@archestra/shared/types";
import type { Azure, OpenAi } from "@/types";
import { toResponsesUsage } from "./responses-usage";

type ResponsesRequest = Azure.Types.ResponsesRequest;
type ResponsesResponse = Azure.Types.ResponsesResponse;
type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;
type OpenAiResponse = OpenAi.Types.ChatCompletionsResponse;

type LooseResponseItem = Record<string, unknown>;

export interface OpenaiResponsesContext {
  responseId: string;
  createdUnix: number;
  requestedModel: string;
}

export function responsesToOpenaiChat(
  req: ResponsesRequest,
  options?: { preserveContentParts: boolean },
): {
  chatBody: OpenAiRequest;
  responsesContext: OpenaiResponsesContext;
} {
  const messages: OpenAiRequest["messages"] = [];

  if (req.instructions) {
    messages.push({ role: "system", content: req.instructions });
  }

  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
  } else if (Array.isArray(req.input)) {
    messages.push(
      ...responseInputToChatMessages(
        req.input as unknown as LooseResponseItem[],
        options?.preserveContentParts,
      ),
    );
  }

  const chatBody: OpenAiRequest = {
    model: req.model,
    messages,
    stream: req.stream === true ? true : undefined,
  };

  if (req.temperature !== undefined) {
    chatBody.temperature = req.temperature;
  }

  if (req.max_output_tokens !== undefined) {
    chatBody.max_tokens = req.max_output_tokens;
  }

  if (req.tools) {
    chatBody.tools = req.tools.flatMap((tool) => {
      if (tool.type !== "function" || !("name" in tool)) {
        return [];
      }
      return [
        {
          type: "function" as const,
          function: {
            name: tool.name as string,
            description:
              typeof tool.description === "string"
                ? tool.description
                : undefined,
            parameters:
              typeof tool.parameters === "object" && tool.parameters !== null
                ? (tool.parameters as Record<string, unknown>)
                : undefined,
          },
        },
      ];
    });
  }

  if (typeof req.tool_choice === "string") {
    chatBody.tool_choice = responseToolChoiceToChatToolChoice(req.tool_choice);
  }

  return {
    chatBody,
    responsesContext: {
      responseId: `resp_${randomUUID()}`,
      createdUnix: Math.floor(Date.now() / 1000),
      requestedModel: req.model,
    },
  };
}

export function chatCompletionToResponses(
  response: OpenAiResponse,
  ctx: OpenaiResponsesContext,
): ResponsesResponse {
  const wireUsage = response.usage as typeof response.usage & {
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
      cache_write_1h_tokens?: number;
    };
  };
  const choice = response.choices[0];
  const output: ResponsesResponse["output"] = [];

  if (choice?.message) {
    const messageContent: Array<{
      type: "output_text";
      text: string;
      annotations: unknown[];
    }> = [];
    if (choice.message.content) {
      messageContent.push({
        type: "output_text",
        text: choice.message.content,
        annotations: [],
      });
    }

    if (messageContent.length > 0) {
      output.push({
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: messageContent,
      } as unknown as ResponsesResponse["output"][number]);
    }

    for (const toolCall of choice.message.tool_calls ?? []) {
      if (toolCall.type !== "function") continue;
      output.push({
        id: toolCall.id,
        call_id: toolCall.id,
        type: "function_call",
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
        status: "completed",
      } as ResponsesResponse["output"][number]);
    }
  }

  return {
    id: ctx.responseId,
    object: "response",
    created_at: ctx.createdUnix,
    model: ctx.requestedModel,
    status: "completed",
    output,
    usage: response.usage
      ? toResponsesUsage({
          inputTokens:
            response.usage.prompt_tokens -
            (wireUsage?.prompt_tokens_details?.cached_tokens ?? 0) -
            (wireUsage?.prompt_tokens_details?.cache_write_tokens ?? 0),
          outputTokens: response.usage.completion_tokens,
          cacheReadTokens: wireUsage?.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens:
            wireUsage?.prompt_tokens_details?.cache_write_tokens ?? 0,
          cacheWrite1hTokens:
            wireUsage?.prompt_tokens_details?.cache_write_1h_tokens,
        })
      : undefined,
  } as ResponsesResponse;
}

function responseInputToChatMessages(
  input: LooseResponseItem[],
  preserveContentParts = false,
): OpenAiRequest["messages"] {
  return input.flatMap((item): OpenAiRequest["messages"] => {
    if (!item || typeof item !== "object") return [];
    if (
      item.type === "message" ||
      item.role === "user" ||
      item.role === "assistant" ||
      item.role === "system" ||
      item.role === "developer"
    ) {
      const role =
        item.role === "assistant"
          ? "assistant"
          : item.role === "system" || item.role === "developer"
            ? "system"
            : "user";
      return [
        {
          role,
          content: preserveContentParts
            ? responseContentToChat(item.content)
            : stringifyResponseContent(item.content),
          ...(preserveContentParts && item.cache_control !== undefined
            ? { cache_control: item.cache_control }
            : {}),
        } as OpenAiRequest["messages"][number],
      ];
    }

    if (item.type === "function_call") {
      return [
        {
          role: "assistant",
          ...(preserveContentParts && item.cache_control !== undefined
            ? { cache_control: item.cache_control }
            : {}),
          content: null,
          tool_calls: [
            {
              id:
                typeof item.call_id === "string"
                  ? item.call_id
                  : `call_${randomUUID()}`,
              type: "function",
              function: {
                name: typeof item.name === "string" ? item.name : "unknown",
                arguments:
                  typeof item.arguments === "string" ? item.arguments : "{}",
              },
            },
          ],
        },
      ];
    }

    if (item.type === "function_call_output") {
      return [
        {
          role: "tool",
          tool_call_id:
            typeof item.call_id === "string" ? item.call_id : "unknown",
          content: preserveContentParts
            ? responseContentToChat(item.output)
            : typeof item.output === "string"
              ? item.output
              : "",
          ...(preserveContentParts && item.cache_control !== undefined
            ? { cache_control: item.cache_control }
            : {}),
        } as OpenAiRequest["messages"][number],
      ];
    }

    if (preserveContentParts && item.cache_control !== undefined)
      throw new ApiError(
        400,
        "Unsupported Bedrock Responses input item with cache_control",
      );
    return [];
  });
}

function responseContentToChat(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part: LooseResponseItem) => {
    if (!part || typeof part !== "object") return part;
    const marker =
      part.cache_control === undefined
        ? {}
        : { cache_control: part.cache_control };
    if (part.type === "input_text" || part.type === "output_text")
      return { type: "text", text: part.text, ...marker };
    if (part.type === "input_image")
      return {
        type: "image_url",
        image_url: { url: part.image_url, detail: part.detail },
        ...marker,
      };
    if (part.type === "input_file")
      return {
        type: "file",
        file: {
          file_data: part.file_data,
          file_id: part.file_id,
          file_url: part.file_url,
          filename: part.filename,
        },
        ...marker,
      };
    return part;
  });
}

function stringifyResponseContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function responseToolChoiceToChatToolChoice(
  toolChoice: string,
): OpenAiRequest["tool_choice"] {
  if (toolChoice === "none") return "none";
  if (toolChoice === "required") return "required";
  return "auto";
}
