"use client";

import type {
  GetAgentsResponses,
  GetInteractionResponse,
} from "@shared/api-client";
import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import ChatBotDemo, { type PartialUIMessage } from "@/components/chatbot-demo";
import Divider from "@/components/divider";
import { InteractionSummary } from "@/components/interaction-summary";
import { LoadingSpinner } from "@/components/loading";
import { useInteraction } from "@/lib/interaction.query";
import {
  parseRefusalMessage,
  toolsRefusedCountForInteraction,
} from "@/lib/interaction.utils";

export function ChatPage({
  initialData,
  id,
}: {
  initialData?: {
    interaction: GetInteractionResponse | undefined;
    agents: GetAgentsResponses["200"];
  };
  id: string;
}) {
  return (
    <div className="container mx-auto">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <Chat initialData={initialData} id={id} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

export function Chat({
  initialData,
  id,
}: {
  initialData?: {
    interaction: GetInteractionResponse | undefined;
    agents: GetAgentsResponses["200"];
  };
  id: string;
}) {
  const { data: interaction } = useInteraction({
    interactionId: id,
    initialData: initialData?.interaction,
  });

  if (!interaction) {
    return "Interaction not found";
  }

  const _refusedCount = toolsRefusedCountForInteraction(interaction);

  // Map request messages
  const requestMessages = interaction.request.messages.map(
    mapInteractionToUiMessage,
  );

  // Add response message if available
  const responseMessage = interaction.response?.choices?.[0]?.message;
  if (responseMessage) {
    requestMessages.push(mapInteractionToUiMessage(responseMessage));
  }

  return (
    <>
      <Divider />
      <div className="px-2">
        <ChatBotDemo
          messages={requestMessages}
          topPart={
            <InteractionSummary
              interaction={interaction}
              agent={initialData?.agents.find(
                (agent) => agent.id === interaction.agentId,
              )}
            />
          }
        />
      </div>
    </>
  );
}

function mapInteractionToUiMessage(
  message:
    | GetInteractionResponse["request"]["messages"][number]
    | GetInteractionResponse["response"]["choices"][number]["message"],
): PartialUIMessage {
  const content = message.content;

  // Map content to UIMessage parts
  const parts: PartialUIMessage["parts"] = [];

  // Handle assistant messages with tool calls
  if (message.role === "assistant" && "tool_calls" in message) {
    const toolCalls = message.tool_calls;

    // Add text content if present
    if (typeof content === "string" && content) {
      parts.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text") {
          parts.push({ type: "text", text: part.text });
        } else if (part.type === "refusal") {
          parts.push({ type: "text", text: part.refusal });
        }
      }
    }

    // Add tool invocation parts
    if (toolCalls) {
      for (const toolCall of toolCalls) {
        if (toolCall.type === "function") {
          parts.push({
            type: "dynamic-tool",
            toolName: toolCall.function.name,
            toolCallId: toolCall.id,
            state: "input-available",
            input: JSON.parse(toolCall.function.arguments),
          });
        } else if (toolCall.type === "custom") {
          parts.push({
            type: "dynamic-tool",
            toolName: toolCall.custom.name,
            toolCallId: toolCall.id,
            state: "input-available",
            input: JSON.parse(toolCall.custom.input),
          });
        }
      }
    }
  }
  // Handle assistant messages with refusals (but no tool calls)
  else if (
    message.role === "assistant" &&
    "refusal" in message &&
    message.refusal
  ) {
    // Parse the refusal message to extract tool information
    const refusalInfo = parseRefusalMessage(message.refusal);

    // Check if this is a tool invocation policy block
    if (refusalInfo.toolName) {
      // Create a special blocked tool part
      parts.push({
        type: "blocked-tool",
        toolName: refusalInfo.toolName,
        toolArguments: refusalInfo.toolArguments,
        reason: refusalInfo.reason || "Tool invocation blocked by policy",
        fullRefusal: message.refusal,
      });
    } else {
      // Regular refusal text
      parts.push({ type: "text", text: message.refusal });
    }
  }
  // Handle tool response messages
  else if (message.role === "tool") {
    const toolContent = message.content;
    const toolCallId = message.tool_call_id;

    // Parse the tool output
    let output: unknown;
    try {
      output =
        typeof toolContent === "string" ? JSON.parse(toolContent) : toolContent;
    } catch {
      output = toolContent;
    }

    parts.push({
      type: "dynamic-tool",
      toolName: "tool-result",
      toolCallId,
      state: "output-available",
      input: {},
      output,
    });
  }
  // Handle regular content
  else {
    if (typeof content === "string") {
      parts.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text") {
          parts.push({ type: "text", text: part.text });
        } else if (part.type === "image_url") {
          parts.push({
            type: "file",
            mediaType: "image/*",
            url: part.image_url.url,
          });
        } else if (part.type === "refusal") {
          parts.push({ type: "text", text: part.refusal });
        }
        // Note: input_audio and file types from API would need additional handling
      }
    }
  }

  // Map role to UIMessage role (only system, user, assistant are allowed)
  let role: "system" | "user" | "assistant";
  if (message.role === "developer" || message.role === "system") {
    role = "system";
  } else if (message.role === "function" || message.role === "tool") {
    role = "assistant";
  } else {
    role = message.role;
  }

  return {
    role,
    parts,
  };
}
