import type { Gemini } from "@/types";
import type { CommonMessage, ToolResultUpdates } from "../types";

type GeminiContents = Gemini.Types.GenerateContentRequest["contents"];

/**
 * Convert Gemini contents to common format for trusted data evaluation
 */
export function toCommonFormat(contents: GeminiContents): CommonMessage[] {
  const commonMessages: CommonMessage[] = [];

  for (const content of contents) {
    const commonMessage: CommonMessage = {
      role: content.role as CommonMessage["role"],
    };

    // Process parts looking for function responses
    if (content.parts) {
      const toolCalls = [];

      for (const part of content.parts) {
        // Check if this part has the functionResponse property
        if (
          "functionResponse" in part &&
          part.functionResponse &&
          typeof part.functionResponse === "object" &&
          "name" in part.functionResponse &&
          "response" in part.functionResponse
        ) {
          const { functionResponse } = part;
          const id =
            "id" in functionResponse && typeof functionResponse.id === "string"
              ? functionResponse.id
              : generateToolCallId(functionResponse.name as string);

          toolCalls.push({
            id,
            name: functionResponse.name as string,
            result: functionResponse.response,
          });
        }
      }

      if (toolCalls.length > 0) {
        commonMessage.toolCalls = toolCalls;
      }
    }

    commonMessages.push(commonMessage);
  }

  return commonMessages;
}

/**
 * Apply tool result updates back to Gemini contents
 */
export function applyUpdates(
  contents: GeminiContents,
  updates: ToolResultUpdates,
): GeminiContents {
  if (Object.keys(updates).length === 0) {
    return contents;
  }

  // biome-ignore lint/suspicious/noExplicitAny: Gemini types need explicit handling
  return contents.map((content): any => {
    // Only process user messages with parts
    if (content.role === "user" && content.parts) {
      const updatedParts = content.parts.map((part) => {
        // Check if this part is a function response
        if (
          "functionResponse" in part &&
          part.functionResponse &&
          typeof part.functionResponse === "object" &&
          "name" in part.functionResponse
        ) {
          const { functionResponse } = part;
          const id =
            "id" in functionResponse && typeof functionResponse.id === "string"
              ? functionResponse.id
              : generateToolCallId(functionResponse.name as string);

          if (updates[id]) {
            // Update the function response with sanitized content
            return {
              functionResponse: {
                ...functionResponse,
                response: { sanitizedContent: updates[id] } as Record<
                  string,
                  unknown
                >,
              },
            };
          }
        }
        return part;
      });

      return {
        ...content,
        parts: updatedParts,
      };
    }

    return content;
  });
}

/**
 * Generate a consistent tool call ID for function responses that don't have one
 * This is needed because Gemini's function responses may not always have an ID
 */
function generateToolCallId(functionName: string): string {
  // Use a simple deterministic approach for now
  // In practice, this might need to be more sophisticated
  return `gemini-tool-${functionName}-${Date.now()}`;
}

/**
 * Extract the user's original request from Gemini contents
 */
export function extractUserRequest(contents: GeminiContents): string {
  // Find the last user content with text
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i];
    if (content.role === "user" && content.parts) {
      for (const part of content.parts) {
        if ("text" in part && part.text && typeof part.text === "string") {
          return part.text;
        }
      }
    }
  }
  return "process this data";
}
