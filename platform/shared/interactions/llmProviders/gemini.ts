import type * as archestraApiTypes from "../../hey-api/clients/api/types.gen";
import type { PartialUIMessage } from "../types";
import type { Interaction, InteractionUtils } from "./common";

// Define more precise types for Gemini parts since the generated types use union discrimination
type GeminiFunctionCallPart = {
  thought?: boolean;
  thoughtSignature?: string;
  functionCall: {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
  };
};

type GeminiFunctionResponsePart = {
  thought?: boolean;
  thoughtSignature?: string;
  functionResponse: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
  };
};

type GeminiTextPart = {
  thought?: boolean;
  thoughtSignature?: string;
  text: string;
};

type GeminiInlineDataPart = {
  thought?: boolean;
  thoughtSignature?: string;
  inlineData: {
    mimeType: string;
    data: string;
  };
};

type GeminiFileDataPart = {
  thought?: boolean;
  thoughtSignature?: string;
  fileData: {
    mimeType?: string;
    fileUri: string;
  };
};

// Type guards for discriminating union types
function hasFunctionResponse(
  part: unknown,
): part is GeminiFunctionResponsePart {
  return (
    typeof part === "object" &&
    part !== null &&
    "functionResponse" in part &&
    part.functionResponse !== undefined
  );
}

function hasFunctionCall(part: unknown): part is GeminiFunctionCallPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "functionCall" in part &&
    part.functionCall !== undefined
  );
}

function hasText(part: unknown): part is GeminiTextPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "text" in part &&
    typeof (part as GeminiTextPart).text === "string"
  );
}

function hasInlineData(part: unknown): part is GeminiInlineDataPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "inlineData" in part &&
    part.inlineData !== undefined
  );
}

function hasFileData(part: unknown): part is GeminiFileDataPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "fileData" in part &&
    part.fileData !== undefined
  );
}

class GeminiGenerateContentInteraction implements InteractionUtils {
  private request: archestraApiTypes.GeminiGenerateContentRequest;
  private response: archestraApiTypes.GeminiGenerateContentResponse;
  modelName: string;

  constructor(interaction: Interaction) {
    this.request =
      interaction.request as archestraApiTypes.GeminiGenerateContentRequest;
    this.response =
      interaction.response as archestraApiTypes.GeminiGenerateContentResponse;
    this.modelName =
      interaction.model ?? (this.response.modelVersion as string) ?? "";
  }

  isLastMessageToolCall(): boolean {
    const messages = this.request.contents;

    if (messages.length === 0) {
      return false;
    }

    const lastMessage = messages[messages.length - 1];

    // Check if last user message contains functionResponse parts
    if (lastMessage.role === "user" && Array.isArray(lastMessage.parts)) {
      return lastMessage.parts.some((part) => hasFunctionResponse(part));
    }

    return false;
  }

  getLastToolCallId(): string | null {
    const messages = this.request.contents;
    if (messages.length === 0) {
      return null;
    }

    // Look for the last functionResponse in user messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "user" && Array.isArray(message.parts)) {
        for (let j = message.parts.length - 1; j >= 0; j--) {
          const part = message.parts[j];
          if (hasFunctionResponse(part) && part.functionResponse.id) {
            return part.functionResponse.id;
          }
        }
      }
    }

    return null;
  }

  getToolNamesUsed(): string[] {
    const toolsUsed = new Set<string>();

    // Tools are invoked by the model in functionCall parts
    for (const message of this.request.contents) {
      if (message.role === "model" && Array.isArray(message.parts)) {
        for (const part of message.parts) {
          if (hasFunctionCall(part) && part.functionCall.name) {
            toolsUsed.add(part.functionCall.name);
          }
        }
      }
    }

    return Array.from(toolsUsed);
  }

  getToolNamesRequested(): string[] {
    const toolsRequested = new Set<string>();

    // Check the response for functionCall parts (tools that LLM wants to execute)
    if (this.response.candidates) {
      for (const candidate of this.response.candidates) {
        if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
            if (hasFunctionCall(part) && part.functionCall.name) {
              toolsRequested.add(part.functionCall.name);
            }
          }
        }
      }
    }

    return Array.from(toolsRequested);
  }

  getLastUserMessage(): string {
    // Handle case where contents might be undefined or not an array
    if (!this.request.contents || !Array.isArray(this.request.contents)) {
      return "";
    }

    const reversedMessages = [...this.request.contents].reverse();
    for (const message of reversedMessages) {
      if (message.role !== "user") {
        continue;
      }

      if (Array.isArray(message.parts)) {
        // First pass: look for text content
        for (const part of message.parts) {
          if (hasText(part) && part.text) {
            return part.text;
          }
        }

        // Second pass: provide descriptive fallback for non-text content
        for (const part of message.parts) {
          if (hasFunctionResponse(part)) {
            return `[Function response: ${part.functionResponse.name}]`;
          }
          if (hasFunctionCall(part)) {
            return `[Function call: ${part.functionCall.name}]`;
          }
          if (hasInlineData(part)) {
            return `[${part.inlineData.mimeType} data]`;
          }
          if (hasFileData(part)) {
            const fileName =
              part.fileData.fileUri.split("/").pop() || part.fileData.fileUri;
            return `[File: ${fileName}]`;
          }
        }
      }
    }
    return "";
  }

  getLastAssistantResponse(): string {
    const candidate = this.response.candidates?.[0];
    if (!candidate?.content?.parts) {
      return "";
    }

    // Find the first text part in the response
    for (const part of candidate.content.parts) {
      if (hasText(part) && part.text) {
        return part.text;
      }
    }

    return "";
  }

  private mapToUiMessage(
    content:
      | archestraApiTypes.GeminiGenerateContentRequest["contents"][number]
      | {
          role: "model";
          // `candidates` is optional — prompt-blocked replies carry only
          // `promptFeedback` — so unwrap before indexing.
          content: NonNullable<
            archestraApiTypes.GeminiGenerateContentResponse["candidates"]
          >[number]["content"];
        },
  ): PartialUIMessage {
    const parts: PartialUIMessage["parts"] = [];
    const { role } = content;
    const contentParts =
      "parts" in content ? content.parts : content.content?.parts;

    if (!Array.isArray(contentParts)) {
      return {
        role:
          role === "model" ? "assistant" : (role as PartialUIMessage["role"]),
        parts,
      };
    }

    // Process content parts
    for (const part of contentParts) {
      if (hasText(part) && part.text) {
        parts.push({ type: "text", text: part.text });
      } else if (hasFunctionCall(part) && part.functionCall) {
        // Tool invocation by model
        parts.push({
          type: "dynamic-tool",
          toolName: part.functionCall.name || "unknown",
          toolCallId: part.functionCall.id || `gemini-${Date.now()}`,
          state: "input-available",
          input: part.functionCall.args || {},
        });
      } else if (hasInlineData(part) && part.inlineData) {
        // Inline image/file data - convert base64 to data URL
        const dataUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        parts.push({
          type: "file",
          mediaType: part.inlineData.mimeType,
          url: dataUrl,
        });
      } else if (hasFileData(part) && part.fileData) {
        // File reference
        parts.push({
          type: "file",
          mediaType: part.fileData.mimeType || "application/octet-stream",
          url: part.fileData.fileUri,
        });
      }
      // Note: functionResponse parts are handled in mapToUiMessages() where they're merged
    }

    return {
      role: role === "model" ? "assistant" : (role as PartialUIMessage["role"]),
      parts,
    };
  }

  private mapRequestToUiMessages(): PartialUIMessage[] {
    const uiMessages: PartialUIMessage[] = [];
    const messages = this.request.contents;

    // Track which user messages contain only functionResponse parts (to skip them later)
    const userMessagesWithFunctionResponses = new Set<number>();

    // First pass: identify user messages that only contain functionResponse parts
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "user" && Array.isArray(msg.parts)) {
        const hasOnlyFunctionResponses = msg.parts.every((part) =>
          hasFunctionResponse(part),
        );
        if (hasOnlyFunctionResponses && msg.parts.length > 0) {
          userMessagesWithFunctionResponses.add(i);
        }
      }
    }

    // Map request messages
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // Skip user messages that only contain function responses - they'll be merged with model
      if (userMessagesWithFunctionResponses.has(i)) {
        continue;
      }

      const uiMessage = this.mapToUiMessage(msg);

      // If this is a model message with functionCall parts, look ahead for function responses
      if (msg.role === "model" && Array.isArray(msg.parts)) {
        const hasFunctionCallPart = msg.parts.some((part) =>
          hasFunctionCall(part),
        );

        if (hasFunctionCallPart) {
          const toolCallParts: PartialUIMessage["parts"] = [...uiMessage.parts];

          // For each functionCall part, find its corresponding functionResponse
          for (const part of msg.parts) {
            if (hasFunctionCall(part) && part.functionCall) {
              const functionCallId = part.functionCall.id;
              const functionCallName = part.functionCall.name;

              // Look for the function response in the next user message
              const functionResponseMsg = messages
                .slice(i + 1)
                .find(
                  (m) =>
                    m.role === "user" &&
                    Array.isArray(m.parts) &&
                    m.parts.some(
                      (p) =>
                        hasFunctionResponse(p) &&
                        (p.functionResponse.id === functionCallId ||
                          p.functionResponse.name === functionCallName),
                    ),
                );

              if (
                functionResponseMsg &&
                Array.isArray(functionResponseMsg.parts)
              ) {
                // Find the specific functionResponse part
                const functionResponsePart = functionResponseMsg.parts.find(
                  (p) =>
                    hasFunctionResponse(p) &&
                    (p.functionResponse.id === functionCallId ||
                      p.functionResponse.name === functionCallName),
                );

                if (
                  functionResponsePart &&
                  hasFunctionResponse(functionResponsePart)
                ) {
                  // Parse the function response
                  const output =
                    functionResponsePart.functionResponse.response || {};

                  // Add function result part
                  toolCallParts.push({
                    type: "dynamic-tool",
                    toolName: functionCallName || "tool-result",
                    toolCallId: functionCallId || `gemini-${Date.now()}`,
                    state: "output-available",
                    input: {},
                    output,
                  });
                }
              }
            }
          }

          uiMessages.push({
            ...uiMessage,
            parts: toolCallParts,
          });
        } else {
          uiMessages.push(uiMessage);
        }
      } else {
        uiMessages.push(uiMessage);
      }
    }

    return uiMessages;
  }

  private mapResponseToUiMessages(): PartialUIMessage[] {
    return (
      this.response?.candidates?.map((candidate) =>
        this.mapToUiMessage({
          role: "model",
          content: candidate.content,
        }),
      ) ?? []
    );
  }

  mapToUiMessages(): PartialUIMessage[] {
    return [
      ...this.mapRequestToUiMessages(),
      ...this.mapResponseToUiMessages(),
    ];
  }
}

export default GeminiGenerateContentInteraction;
