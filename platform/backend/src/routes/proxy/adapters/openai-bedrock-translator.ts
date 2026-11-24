import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { openAIUsageTokens } from "@/observability/metrics/llm-usage";
import type { Bedrock, OpenAi } from "@/types";
import { ApiError } from "@/types/api";
import { asRecord } from "@/utils/as-record";
import { UpstreamStreamIncompleteError } from "@/utils/upstream-stream-incomplete-error";
import { wordToolCallId } from "../utils/tool-call-ids";

type Request = Bedrock.Types.ConverseRequest;
type ChatRequest = OpenAi.Types.ChatCompletionsRequest & {
  top_p?: number;
  stop?: string[];
};
type Chunk = OpenAi.Types.ChatCompletionChunk;
type Message = ChatRequest["messages"][number];

function fields(value: unknown, allowed: readonly string[]) {
  const record = asRecord(value);
  return record && Object.keys(record).every((key) => allowed.includes(key))
    ? record
    : undefined;
}

function every(value: unknown, predicate: (item: unknown) => boolean): boolean {
  return (
    value === undefined || (Array.isArray(value) && value.every(predicate))
  );
}

function textBlock(value: unknown, system = false): boolean {
  const record = fields(value, system ? ["text", "type"] : ["text"]);
  return (
    typeof record?.text === "string" &&
    (record.type === undefined || record.type === "text")
  );
}

function inlineImage(value: unknown): boolean {
  const block = fields(value, ["image"]);
  const image = fields(block?.image, ["format", "source"]);
  return (
    typeof image?.format === "string" &&
    typeof fields(image.source, ["bytes"])?.bytes === "string"
  );
}

function functionCall(value: unknown): boolean {
  const tool = fields(fields(value, ["toolUse"])?.toolUse, [
    "toolUseId",
    "name",
    "input",
  ]);
  return Boolean(tool && asRecord(tool.input));
}

function toolResult(value: unknown): boolean {
  const result = fields(fields(value, ["toolResult"])?.toolResult, [
    "toolUseId",
    "content",
  ]);
  return (
    Array.isArray(result?.content) &&
    result.content.every(
      (part) =>
        textBlock(part) || Boolean(asRecord(fields(part, ["json"])?.json)),
    )
  );
}

function portableMessage(value: unknown): boolean {
  const message = fields(value, ["role", "content"]);
  if (!Array.isArray(message?.content)) return false;
  let passedToolBoundary = false;
  return message.content.every((part) => {
    if (message.role === "assistant") {
      if (functionCall(part)) {
        passedToolBoundary = true;
        return true;
      }
      return !passedToolBoundary && textBlock(part);
    }
    if (message.role !== "user") return false;
    if (textBlock(part) || inlineImage(part)) {
      passedToolBoundary = true;
      return true;
    }
    return !passedToolBoundary && toolResult(part);
  });
}

function portableTools(value: unknown): boolean {
  if (value === undefined) return true;
  const config = fields(value, ["tools", "toolChoice"]);
  if (
    !config ||
    !Array.isArray(config.tools) ||
    !config.tools.every((entry) => {
      const spec = fields(fields(entry, ["toolSpec"])?.toolSpec, [
        "name",
        "description",
        "inputSchema",
      ]);
      return Boolean(asRecord(fields(spec?.inputSchema, ["json"])?.json));
    })
  )
    return false;
  if (config.toolChoice === undefined) return true;
  const choice = fields(config.toolChoice, ["auto", "any", "tool"]);
  if (!choice || Object.keys(choice).length !== 1) return false;
  return (
    !!fields(choice.auto, []) ||
    !!fields(choice.any, []) ||
    typeof fields(choice.tool, ["name"])?.name === "string"
  );
}

/** Check the raw wire before validation (which can strip unknown fields) and
 * the final provider request after proxy transformations. An AWS-only request
 * can still use a Bedrock member but must not leave the Converse wire. */
export function canTranslateConverseRequest(value: unknown, urlModel?: string) {
  const body = fields(value, [
    "modelId",
    "messages",
    "system",
    "inferenceConfig",
    "toolConfig",
    "_isStreaming",
  ]);
  const promptArn = /(?:^|:)prompt\//;
  return (
    !!body &&
    !(typeof body.modelId === "string" && promptArn.test(body.modelId)) &&
    !(urlModel && promptArn.test(urlModel)) &&
    every(body.messages, portableMessage) &&
    every(body.system, (part) => textBlock(part, true)) &&
    (body.inferenceConfig === undefined ||
      !!fields(body.inferenceConfig, [
        "maxTokens",
        "temperature",
        "topP",
        "stopSequences",
      ])) &&
    portableTools(body.toolConfig)
  );
}

export function converseToOpenai(request: Request): ChatRequest {
  if (!canTranslateConverseRequest(request)) {
    throw new ApiError(
      400,
      "This Converse request requires a Bedrock model pool member to preserve its native options or content.",
    );
  }
  const messages: Message[] = [];
  for (const block of request.system ?? []) {
    if ("text" in block && typeof block.text === "string")
      messages.push({ role: "system", content: block.text });
  }
  for (const message of request.messages ?? []) {
    if (message.role === "assistant") {
      const text: string[] = [];
      const tools: NonNullable<
        Extract<Message, { role: "assistant" }>["tool_calls"]
      > = [];
      for (const block of message.content) {
        if ("text" in block) text.push(block.text);
        if ("toolUse" in block) {
          const tool = block.toolUse;
          tools.push({
            id: tool.toolUseId,
            type: "function",
            function: {
              name: tool.name,
              arguments: JSON.stringify(tool.input),
            },
          });
        }
      }
      messages.push({
        role: "assistant",
        content: text.join("\n") || null,
        ...(tools.length ? { tool_calls: tools } : {}),
      });
    } else {
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      > = [];
      for (const block of message.content) {
        if ("text" in block) content.push({ type: "text", text: block.text });
        if ("image" in block && "bytes" in block.image.source) {
          content.push({
            type: "image_url",
            image_url: {
              url: `data:image/${block.image.format};base64,${block.image.source.bytes}`,
            },
          });
        }
        if ("toolResult" in block) {
          messages.push({
            role: "tool",
            tool_call_id: block.toolResult.toolUseId,
            content: block.toolResult.content
              .map((item) =>
                "text" in item
                  ? item.text
                  : "json" in item
                    ? JSON.stringify(item.json)
                    : "",
              )
              .join("\n"),
          });
        }
      }
      if (content.length) messages.push({ role: "user", content });
    }
  }
  const config = request.inferenceConfig;
  const tools = request.toolConfig?.tools.flatMap((entry) =>
    entry.toolSpec
      ? [
          {
            type: "function" as const,
            function: {
              name: entry.toolSpec.name,
              description: entry.toolSpec.description,
              parameters: entry.toolSpec.inputSchema.json,
            },
          },
        ]
      : [],
  );
  const choice = request.toolConfig?.toolChoice;
  const name = asRecord(choice?.tool)?.name;
  return {
    model: request.modelId,
    messages,
    max_tokens: config?.maxTokens,
    temperature: config?.temperature,
    top_p: config?.topP,
    stop: config?.stopSequences,
    ...(tools?.length ? { tools } : {}),
    ...(typeof name === "string"
      ? { tool_choice: { type: "function", function: { name } } }
      : choice?.any
        ? { tool_choice: "required" }
        : choice?.auto
          ? { tool_choice: "auto" }
          : {}),
  };
}

function converseStopReason(reason: string, stoppedOnSequence = false) {
  if (reason === "stop" && stoppedOnSequence) return "stop_sequence";
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "content_filtered";
    default:
      return "end_turn";
  }
}

function converseUsage(usage: OpenAi.Types.Usage | null | undefined) {
  const tokens = usage ? openAIUsageTokens(usage) : null;
  const write1h = tokens?.cacheWrite1h ?? 0;
  return {
    inputTokens: tokens?.input ?? 0,
    outputTokens: tokens?.output ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
    ...(tokens?.cacheRead ? { cacheReadInputTokens: tokens.cacheRead } : {}),
    ...(tokens?.cacheWrite ? { cacheWriteInputTokens: tokens.cacheWrite } : {}),
    ...(write1h > 0
      ? { cacheDetails: [{ ttl: "1h" as const, inputTokens: write1h }] }
      : {}),
  };
}

function toolArgumentsJson(input: string) {
  // A parameterless streamed call may have no argument deltas at all.
  return input.trim() ? input : "{}";
}

function toolInput(argumentsJson: string): Record<string, unknown> {
  try {
    const input = asRecord(JSON.parse(argumentsJson));
    if (input) return input;
  } catch {
    // Do not echo the upstream's JSON or the syntax error's input snippet.
  }
  throw new Error("The upstream returned malformed tool arguments");
}

export function openaiResponseToConverse(
  response: OpenAi.Types.ChatCompletionsResponse,
  stoppedOnSequence = false,
): Bedrock.Types.ConverseResponse {
  const answer = response.choices[0];
  if (!answer?.finish_reason) {
    throw new UpstreamStreamIncompleteError(
      "The upstream did not return a complete answer",
    );
  }
  const content: NonNullable<
    Bedrock.Types.ConverseResponse["output"]["message"]
  >["content"] = [];
  const text = answer.message.content ?? answer.message.refusal;
  if (text) content.push({ text });
  for (const call of answer.message.tool_calls ?? []) {
    if (call.type !== "function")
      throw new Error("The upstream returned an unsupported tool call");
    content.push({
      toolUse: {
        toolUseId: wordToolCallId(call.id),
        name: call.function.name,
        input: toolInput(toolArgumentsJson(call.function.arguments)),
      },
    });
  }
  return {
    output: { message: { role: "assistant", content } },
    stopReason: converseStopReason(answer.finish_reason, stoppedOnSequence),
    usage: converseUsage(response.usage),
  };
}

export function createOpenaiToConverseStreamTranslator(
  stoppedOnSequence?: () => boolean,
) {
  const tools = new Map<number, { id: string; name: string; input: string }>();
  let started = false;
  let textStarted = false;
  let stopReason: ReturnType<typeof converseStopReason> | undefined;
  let usage: ReturnType<typeof converseUsage> | undefined;
  return {
    translate(chunk: Chunk): ConverseStreamOutput[] {
      if (chunk.usage) usage = converseUsage(chunk.usage);
      const choice = chunk.choices[0];
      if (!choice) return [];
      if (choice.finish_reason)
        stopReason = converseStopReason(
          choice.finish_reason,
          stoppedOnSequence?.(),
        );
      const events: ConverseStreamOutput[] = [];
      const text = choice.delta.content ?? choice.delta.refusal;
      if (text) {
        if (!started) {
          events.push({ messageStart: { role: "assistant" } });
          started = true;
        }
        textStarted = true;
        events.push({
          contentBlockDelta: { contentBlockIndex: 0, delta: { text } },
        });
      }
      if (choice.delta.tool_calls?.length && !started) {
        events.push({ messageStart: { role: "assistant" } });
        started = true;
      }
      for (const part of choice.delta.tool_calls ?? []) {
        if (part.type && part.type !== "function")
          throw new Error("The upstream returned an unsupported tool call");
        const tool = tools.get(part.index) ?? { id: "", name: "", input: "" };
        if (part.id) tool.id = part.id;
        if (part.function?.name) tool.name += part.function.name;
        if (part.function?.arguments) tool.input += part.function.arguments;
        tools.set(part.index, tool);
      }
      return events;
    },
    finish(): ConverseStreamOutput[] {
      if (!stopReason) {
        throw new UpstreamStreamIncompleteError(
          "The upstream stream ended before it finished",
        );
      }
      // Chat chunks may interleave tool arguments; Converse exposes complete,
      // sequential blocks. Validate all tools before emitting their events.
      const events: ConverseStreamOutput[] = [];
      if (!started) events.push({ messageStart: { role: "assistant" } });
      if (textStarted)
        events.push({ contentBlockStop: { contentBlockIndex: 0 } });
      let contentBlockIndex = textStarted ? 1 : 0;
      for (const [, tool] of [...tools].sort(([a], [b]) => a - b)) {
        if (!tool.id || !tool.name)
          throw new Error("The upstream returned an incomplete tool call");
        const input = toolArgumentsJson(tool.input);
        toolInput(input);
        events.push(
          {
            contentBlockStart: {
              contentBlockIndex,
              start: {
                toolUse: {
                  toolUseId: wordToolCallId(tool.id),
                  name: tool.name,
                },
              },
            },
          },
          {
            contentBlockDelta: {
              contentBlockIndex,
              delta: { toolUse: { input } },
            },
          },
          { contentBlockStop: { contentBlockIndex } },
        );
        contentBlockIndex++;
      }
      events.push(
        { messageStop: { stopReason } },
        {
          metadata: {
            usage: usage ?? converseUsage(undefined),
            metrics: undefined,
          },
        },
      );
      return events;
    },
  };
}
