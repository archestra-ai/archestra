import type { archestraApiTypes } from "@shared";
import type { PartialUIMessage } from "@/components/chatbot-demo";
import type { DualLlmResult, Interaction, InteractionUtils } from "./common";

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
    this.modelName = this.response.modelVersion as string;
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
        for (const part of message.parts) {
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

  getToolNamesRefused(): string[] {
    const toolsRefused = new Set<string>();

    // Check for text blocks containing tool refusal patterns
    for (const message of this.request.contents) {
      if (message.role === "model" && Array.isArray(message.parts)) {
        for (const part of message.parts) {
          if (hasText(part) && part.text) {
            const toolName = part.text.match(
              /<archestra-tool-name>(.*?)<\/archestra-tool-name>/,
            )?.[1];
            if (toolName) {
              toolsRefused.add(toolName);
            }
          }
        }
      }
    }

    // Check response candidates
    if (this.response.candidates) {
      for (const candidate of this.response.candidates) {
        if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
            if (hasText(part) && part.text) {
              const toolName = part.text.match(
                /<archestra-tool-name>(.*?)<\/archestra-tool-name>/,
              )?.[1];
              if (toolName) {
                toolsRefused.add(toolName);
              }
            }
          }
        }
      }
    }

    return Array.from(toolsRefused);
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

  getToolRefusedCount(): number {
    let count = 0;

    // Count refusals in request messages
    for (const message of this.request.contents) {
      if (message.role === "model" && Array.isArray(message.parts)) {
        for (const part of message.parts) {
          if (hasText(part) && part.text) {
            if (part.text.includes("<archestra-tool-name>")) {
              count++;
            }
          }
        }
      }
    }

    // Count refusals in response
    if (this.response.candidates) {
      for (const candidate of this.response.candidates) {
        if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
            if (hasText(part) && part.text) {
              if (part.text.includes("<archestra-tool-name>")) {
                count++;
              }
            }
          }
        }
      }
    }

    return count;
  }

  getLastUserMessage(): string {
    const reversedMessages = [...this.request.contents].reverse();
    for (const message of reversedMessages) {
      if (message.role !== "user") {
        continue;
      }

      if (Array.isArray(message.parts)) {
        // Find the first text part that's not a functionResponse
        for (const part of message.parts) {
          if (hasText(part) && part.text) {
            return part.text;
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
          content: archestraApiTypes.GeminiGenerateContentResponse["candidates"][number]["content"];
        },
    _dualLlmResults?: DualLlmResult[],
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

  private mapRequestToUiMessages(
    dualLlmResults?: DualLlmResult[],
  ): PartialUIMessage[] {
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

      const uiMessage = this.mapToUiMessage(msg, dualLlmResults);

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
                    toolName: "tool-result",
                    toolCallId: functionCallId || `gemini-${Date.now()}`,
                    state: "output-available",
                    input: {},
                    output,
                  });

                  // Check for dual LLM result
                  const dualLlmResultForTool = dualLlmResults?.find(
                    (result) => result.toolCallId === functionCallId,
                  );

                  if (dualLlmResultForTool) {
                    toolCallParts.push({
                      type: "dual-llm-analysis",
                      toolCallId: dualLlmResultForTool.toolCallId,
                      safeResult: dualLlmResultForTool.result,
                      conversations: Array.isArray(
                        dualLlmResultForTool.conversations,
                      )
                        ? (dualLlmResultForTool.conversations as Array<{
                            role: "user" | "assistant";
                            content: string | unknown;
                          }>)
                        : [],
                    });
                  }
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

  mapToUiMessages(dualLlmResults?: DualLlmResult[]): PartialUIMessage[] {
    return [
      ...this.mapRequestToUiMessages(dualLlmResults),
      ...this.mapResponseToUiMessages(),
    ];
  }
}

export default GeminiGenerateContentInteraction;
