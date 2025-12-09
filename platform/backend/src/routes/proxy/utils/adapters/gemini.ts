import logger from "@/logging";
import type { CommonMessage, Gemini, ToolResultUpdates } from "@/types";

type GeminiContents = Gemini.Types.GenerateContentRequest["contents"];

/**
 * Convert Gemini contents to common format for trusted data evaluation
 */
export function toCommonFormat(_contents: GeminiContents): CommonMessage[] {
  logger.debug(
    { contentsCount: _contents?.length || 0 },
    "[adapters/gemini] toCommonFormat: starting conversion (TODO: not fully implemented)",
  );
  const commonMessages: CommonMessage[] = [];

  // TODO: implement this
  // for (const content of contents) {
  //   const commonMessage: CommonMessage = {
  //     role: content.role as CommonMessage["role"],
  //   };

  //   // Process parts looking for function responses
  //   if (content.parts) {
  //     const toolCalls = [];

  //     for (const part of content.parts) {
  //       // Check if this part has the functionResponse property
  //       const partWithResponse = part as any;
  //       if (
  //         "functionResponse" in partWithResponse &&
  //         partWithResponse.functionResponse
  //       ) {
  //         const { functionResponse } = partWithResponse;

  //         // Parse the function response
  //         const toolResult: unknown = functionResponse.response;

  //         toolCalls.push({
  //           id:
  //             functionResponse.id || generateToolCallId(functionResponse.name),
  //           name: functionResponse.name,
  //           result: toolResult,
  //         });
  //       }
  //     }

  //     if (toolCalls.length > 0) {
  //       commonMessage.toolCalls = toolCalls;
  //     }
  //   }

  //   commonMessages.push(commonMessage);
  // }

  return commonMessages;
}

/**
 * Apply tool result updates back to Gemini contents
 */
export function applyUpdates(
  contents: GeminiContents,
  updates: ToolResultUpdates,
): GeminiContents {
  const updateCount = Object.keys(updates).length;
  logger.debug(
    { contentsCount: contents?.length || 0, updateCount },
    "[adapters/gemini] applyUpdates: starting (TODO: not fully implemented)",
  );

  if (updateCount === 0) {
    logger.debug("[adapters/gemini] applyUpdates: no updates to apply");
    return contents;
  }

  // TODO: implement this
  logger.debug(
    "[adapters/gemini] applyUpdates: updates not applied (not implemented)",
  );
  return contents;
}

/**
 * Generate a consistent tool call ID for function responses that don't have one
 * This is needed because Gemini's function responses may not always have an ID
 */
function _generateToolCallId(functionName: string): string {
  // Use a simple deterministic approach for now
  // In practice, this might need to be more sophisticated
  return `gemini-tool-${functionName}-${Date.now()}`;
}

/**
 * Extract the user's original request from Gemini contents
 */
export function extractUserRequest(_contents: GeminiContents): string {
  // Find the last user content with text
  // for (let i = contents.length - 1; i >= 0; i--) {
  //   const content = contents[i];
  //   if (content.role === "user" && content.parts) {
  //     for (const part of content.parts) {
  //       const partWithText = part as any;
  //       if ("text" in partWithText && partWithText.text) {
  //         return partWithText.text;
  //       }
  //     }
  //   }
  // }
  return "process this data";
}

type GeminiUsage = Pick<
  Gemini.Types.UsageMetadata,
  "promptTokenCount" | "candidatesTokenCount"
>;
/** Returns Gemini input and output usage tokens */
export function getUsageTokens(usage: GeminiUsage) {
  return {
    input: usage.promptTokenCount,
    output: usage.candidatesTokenCount,
  };
}
