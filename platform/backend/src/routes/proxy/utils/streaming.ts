import type { Stream } from "openai/core/streaming";
import type {
  CommonChatCompletionChunk,
  CommonMessage,
  CommonToolCall,
} from "../types/common";

/**
 * Accumulate the assistant message, and tool calls from chunks
 */
export const handleChatCompletions = async (
  stream: Stream<CommonChatCompletionChunk>,
): Promise<{
  message: CommonMessage;
  chunks: CommonChatCompletionChunk[];
}> => {
  let accumulatedContent = "";
  let accumulatedRefusal = "";
  const accumulatedToolCalls: CommonToolCall[] = [];
  const chunks: CommonChatCompletionChunk[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
    const delta = chunk.choices[0]?.delta;

    // Accumulate content
    if (delta?.content) {
      accumulatedContent += delta.content;
    }

    if (delta?.refusal) {
      accumulatedRefusal += delta.refusal;
    }

    // Accumulate tool calls
    if (delta?.tool_calls) {
      for (const toolCallDelta of delta.tool_calls) {
        const index = toolCallDelta.index ?? 0;

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
  }

  return {
    message: {
      role: "assistant",
      content: accumulatedContent || null,
      refusal: accumulatedRefusal || null,
      tool_calls:
        accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
    },
    chunks,
  };
};
