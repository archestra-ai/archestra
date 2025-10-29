import type { GenerateContentParameters } from "@google/genai";
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
 * Returns an array of Content objects, not ContentListUnion
 */
export function applyUpdates(
  contents: GeminiContents,
  updates: ToolResultUpdates,
): GeminiContents {
  if (Object.keys(updates).length === 0) {
    return contents;
  }

  return contents.map((content) => {
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
export function generateToolCallId(functionName: string): string {
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

/**
 * Convert a Gemini REST-style GenerateContentRequest body into the SDK's
 * GenerateContentParameters shape. The SDK and REST shapes differ significantly:
 * - SDK expects contents as an array of Content objects
 * - SDK expects tools, systemInstruction, and generationConfig at top level
 * - SDK doesn't use a nested "config" object for these parameters
 */
export function restToSdkGenerateContentParams(
  body: Partial<Gemini.Types.GenerateContentRequest>,
  model: string,
  mergedTools?: Gemini.Types.Tool[] | undefined,
): GenerateContentParameters {
  const params: Record<string, unknown> = {};

  // Required model param for SDK calls
  params.model = model;

  // Convert contents to array format expected by SDK
  if (Array.isArray(body.contents)) {
    // REST-style array or from applyUpdates - use as-is
    params.contents = body.contents;
  } else {
    params.contents = [];
  }

  // Handle tools - SDK expects them at top level, not under config
  if (mergedTools && mergedTools.length > 0) {
    params.tools = mergedTools;
  }

  // Handle systemInstruction at top level
  if (body.systemInstruction) {
    params.systemInstruction = body.systemInstruction;
  }

  // Handle generationConfig - SDK expects it at top level
  if (body.generationConfig) {
    params.generationConfig = body.generationConfig;
  } else {
    // Build generationConfig from individual parameters if present
    const generationConfig: Record<string, unknown> = {};
    const configKeys = [
      "temperature",
      "maxOutputTokens",
      "candidateCount",
      "topP",
      "topK",
      "stopSequences",
    ];
    for (const k of configKeys) {
      const val = (body as unknown as Record<string, unknown>)[k];
      if (val !== undefined) generationConfig[k] = val;
    }
    if (Object.keys(generationConfig).length > 0) {
      params.config = generationConfig;
    }
  }

  // Handle safetySettings at top level
  if (body.safetySettings) {
    params.safetySettings = body.safetySettings;
  }

  // Handle toolConfig at top level
  if (body.toolConfig) {
    params.toolConfig = body.toolConfig;
  }

  // Handle cachedContent
  if (body.cachedContent) {
    params.cachedContent = body.cachedContent;
  }

  return params as unknown as GenerateContentParameters;
}
