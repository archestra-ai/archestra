import { randomUUID } from "node:crypto";
import type { Azure, OpenAi } from "@/types";

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

export function responsesToOpenaiChat(req: ResponsesRequest): {
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
      ? {
          input_tokens: response.usage.prompt_tokens,
          output_tokens: response.usage.completion_tokens,
          total_tokens: response.usage.total_tokens,
        }
      : undefined,
  } as ResponsesResponse;
}

function responseInputToChatMessages(
  input: LooseResponseItem[],
): OpenAiRequest["messages"] {
  return input.flatMap((item) => {
    if (item.type === "message") {
      const role = item.role === "assistant" ? "assistant" : "user";
      return [
        {
          role,
          content: stringifyResponseContent(item.content),
        } as OpenAiRequest["messages"][number],
      ];
    }

    if (item.type === "function_call") {
      return [
        {
          role: "assistant",
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
          content: typeof item.output === "string" ? item.output : "",
        },
      ];
    }

    return [];
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
