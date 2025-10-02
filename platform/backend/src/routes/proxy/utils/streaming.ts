import type { FastifyReply } from "fastify";
import type OpenAI from "openai";
import type { Stream } from "openai/core/streaming";

export const handleChatCompletions = async (
  reply: FastifyReply,
  stream: Stream<OpenAI.Chat.Completions.ChatCompletionChunk>,
): Promise<OpenAI.Chat.Completions.ChatCompletionMessage> => {
  /**
   * Accumulate the assistant message, and tool calls from chunks
   *
   * NOTE: for right now we ignore "custom" tool calls
   */
  let accumulatedContent = "";
  const accumulatedToolCalls: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[] =
    [];

  reply.header("Content-Type", "text/event-stream");
  reply.header("Cache-Control", "no-cache");
  reply.header("Connection", "keep-alive");

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;

    // Accumulate content
    if (delta?.content) {
      accumulatedContent += delta.content;
    }

    // Accumulate tool calls
    if (delta?.tool_calls) {
      for (const toolCallDelta of delta.tool_calls.filter(
        (toolCall) => toolCall.type === "function",
      )) {
        const index = toolCallDelta.index;

        // Initialize tool call if it doesn't exist
        if (!accumulatedToolCalls[index]) {
          accumulatedToolCalls[index] = {
            id: toolCallDelta.id || "",
            type: "function",
            function: {
              name: "",
              arguments: "",
            },
          };
        }

        // Accumulate tool call fields
        if (toolCallDelta.id) {
          accumulatedToolCalls[index].id = toolCallDelta.id;
        }
        if (toolCallDelta.function?.name) {
          accumulatedToolCalls[index].function.name =
            toolCallDelta.function.name;
        }
        if (toolCallDelta.function?.arguments) {
          accumulatedToolCalls[index].function.arguments +=
            toolCallDelta.function.arguments;
        }
      }
    }

    // Stream chunk to client
    reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  return {
    role: "assistant",
    content: accumulatedContent || null,
    // TODO: we may need to handle refusal properly here?
    refusal: null,
    tool_calls:
      accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
  };
};
