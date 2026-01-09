import type { PartialUIMessage } from "@/components/chatbot-demo";
import type { DualLlmResult, Interaction, InteractionUtils } from "./common";

// Define Cohere V2 types for frontend use
namespace CohereTypes {
    export type ChatMessage = {
        role: "user" | "assistant" | "system" | "tool";
        content: string | Array<{ type: "text"; text: string }>;
        tool_call_id?: string;
        tool_calls?: Array<{
            id: string;
            type: "function";
            function: {
                name: string;
                arguments: string;
            }
        }>;
    };

    export type ChatRequest = {
        model: string;
        messages: ChatMessage[];
        tools?: Array<{
            type: "function";
            function: {
                name: string;
                description: string;
                parameters: any;
            }
        }>;
    };

    export type ChatResponse = {
        id: string;
        model: string;
        message: {
            role: "assistant";
            content: Array<{ type: "text"; text: string }>;
            tool_calls?: Array<{
                id: string;
                type: "function";
                function: {
                    name: string;
                    arguments: string;
                }
            }>;
        };
        usage?: {
            billed_units?: {
                input_tokens: number;
                output_tokens: number;
            };
            tokens?: {
                input_tokens: number;
                output_tokens: number;
            };
        };
        finish_reason: string;
    };
}

class CohereChatCompletionInteraction implements InteractionUtils {
    private request: CohereTypes.ChatRequest;
    private response: CohereTypes.ChatResponse;
    modelName: string;

    constructor(interaction: Interaction) {
        this.request = interaction.request as CohereTypes.ChatRequest;
        this.response = interaction.response as CohereTypes.ChatResponse;
        this.modelName = interaction.model ?? this.request.model;
    }

    isLastMessageToolCall(): boolean {
        const messages = this.request.messages;
        if (messages.length === 0) return false;
        const lastMessage = messages[messages.length - 1];
        return lastMessage.role === "tool";
    }

    getLastToolCallId(): string | null {
        const messages = this.request.messages;
        if (messages.length === 0) return null;
        const lastMessage = messages[messages.length - 1];
        return lastMessage.role === "tool" ? lastMessage.tool_call_id || null : null;
    }

    getToolNamesUsed(): string[] {
        const toolsUsed = new Set<string>();
        for (const message of this.request.messages) {
            if (message.role === "assistant" && message.tool_calls) {
                for (const toolCall of message.tool_calls) {
                    toolsUsed.add(toolCall.function.name);
                }
            }
        }
        return Array.from(toolsUsed);
    }

    getToolNamesRefused(): string[] {
        // Cohere V2 doesn't have a specific refusal field like OpenAI, 
        // it likely uses text or finish_reason.
        // Archestra's refusal message is injected into the content.
        const toolsRefused = new Set<string>();
        for (const message of this.request.messages) {
            if (message.role === "assistant") {
                const content = typeof message.content === "string"
                    ? message.content
                    : message.content?.[0]?.text;
                if (content) {
                    const toolName = content.match(/<archestra-tool-name>(.*?)<\/archestra-tool-name>/)?.[1];
                    if (toolName) toolsRefused.add(toolName);
                }
            }
        }
        const responseContent = this.response.message?.content?.[0]?.text;
        if (responseContent) {
            const toolName = responseContent.match(/<archestra-tool-name>(.*?)<\/archestra-tool-name>/)?.[1];
            if (toolName) toolsRefused.add(toolName);
        }
        return Array.from(toolsRefused);
    }

    getToolNamesRequested(): string[] {
        const toolsRequested = new Set<string>();
        if (this.response.message?.tool_calls) {
            for (const toolCall of this.response.message.tool_calls) {
                toolsRequested.add(toolCall.function.name);
            }
        }
        return Array.from(toolsRequested);
    }

    getLastUserMessage(): string {
        const reversedMessages = [...this.request.messages].reverse();
        for (const message of reversedMessages) {
            if (message.role !== "user") continue;
            if (typeof message.content === "string") return message.content;
            if (message.content?.[0]?.type === "text") return message.content[0].text;
        }
        return "";
    }

    getLastAssistantResponse(): string {
        return this.response.message?.content?.[0]?.text ?? "";
    }

    getToolRefusedCount(): number {
        return this.getToolNamesRefused().length;
    }

    private mapToUiMessage(
        message: CohereTypes.ChatMessage | CohereTypes.ChatResponse["message"],
    ): PartialUIMessage {
        const parts: PartialUIMessage["parts"] = [];
        const { content, role } = message;

        if (role === "assistant") {
            // Handle text content
            if (typeof content === "string" && content) {
                parts.push({ type: "text", text: content });
            } else if (Array.isArray(content)) {
                for (const part of content) {
                    if (part.type === "text") {
                        parts.push({ type: "text", text: part.text });
                    }
                }
            }

            // Handle tool calls
            if (message.tool_calls) {
                for (const toolCall of message.tool_calls) {
                    parts.push({
                        type: "dynamic-tool",
                        toolName: toolCall.function.name,
                        toolCallId: toolCall.id,
                        state: "input-available",
                        input: typeof toolCall.function.arguments === "string"
                            ? JSON.parse(toolCall.function.arguments)
                            : toolCall.function.arguments,
                    });
                }
            }
        } else if (message.role === "tool") {
            const toolContent = (message as CohereTypes.ChatMessage).content;
            const toolCallId = (message as CohereTypes.ChatMessage).tool_call_id;

            let output: unknown;
            try {
                output = typeof toolContent === "string" ? JSON.parse(toolContent) : toolContent;
            } catch {
                output = toolContent;
            }

            parts.push({
                type: "dynamic-tool",
                toolName: "tool-result",
                toolCallId: toolCallId || "",
                state: "output-available",
                input: {},
                output,
            });
        } else {
            if (typeof content === "string") {
                parts.push({ type: "text", text: content });
            } else if (Array.isArray(content)) {
                for (const part of content) {
                    if (part.type === "text") {
                        parts.push({ type: "text", text: part.text });
                    }
                }
            }
        }

        const cohereRoleToUIMessageRoleMap: Record<string, PartialUIMessage["role"]> = {
            system: "system",
            tool: "assistant",
            user: "user",
            assistant: "assistant",
        };

        return {
            role: cohereRoleToUIMessageRoleMap[role] || "assistant",
            parts,
        };
    }

    mapToUiMessages(dualLlmResults?: DualLlmResult[]): PartialUIMessage[] {
        const uiMessages: PartialUIMessage[] = [];
        const messages = this.request.messages;

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.role === "tool") continue;

            const uiMessage = this.mapToUiMessage(msg);

            if (msg.role === "assistant" && msg.tool_calls) {
                const toolCallParts: PartialUIMessage["parts"] = [...uiMessage.parts];
                for (const toolCall of msg.tool_calls) {
                    const toolResultMsg = messages.slice(i + 1).find(
                        (m) => m.role === "tool" && m.tool_call_id === toolCall.id,
                    );
                    if (toolResultMsg) {
                        const toolResultUiMsg = this.mapToUiMessage(toolResultMsg);
                        toolCallParts.push(...toolResultUiMsg.parts);

                        const dualLlmResultForTool = dualLlmResults?.find(
                            (result) => result.toolCallId === toolCall.id,
                        );
                        if (dualLlmResultForTool) {
                            toolCallParts.push({
                                type: "dual-llm-analysis",
                                toolCallId: dualLlmResultForTool.toolCallId,
                                safeResult: dualLlmResultForTool.result,
                                conversations: (dualLlmResultForTool.conversations as any) || [],
                            });
                        }
                    }
                }
                uiMessages.push({ ...uiMessage, parts: toolCallParts });
            } else {
                uiMessages.push(uiMessage);
            }
        }

        // Add response
        const responseUiMessages = this.mapToUiMessage(this.response.message);
        uiMessages.push(responseUiMessages);

        return uiMessages;
    }
}

export default CohereChatCompletionInteraction;
