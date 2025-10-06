"use client";

import type { GetChatResponses } from "@shared/api-client";
import { Suspense } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import ChatBotDemo, { type PartialUIMessage } from "@/components/chatbot-demo";
import Divider from "@/components/divider";
import { LoadingSpinner } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import { useChat } from "@/lib/chat.query";

export function ChatPage({
  initialData,
  id,
}: {
  initialData?: GetChatResponses["200"];
  id: string;
}) {
  return (
    <div className="container mx-auto max-w-6xl overflow-y-auto">
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
  initialData?: GetChatResponses["200"];
  id: string;
}) {
  const { data: chat } = useChat({ id, initialData });

  if (!chat) {
    return "Chat not found";
  }

  const untrustedCount = chat.interactions.filter((i) => !i.trusted).length;

  return (
    <>
      <div className="p-6 bg-card">
        <div>
          <h1 className="text-3xl font-bold mb-6">Chat: {id}</h1>
          <div className="text-sm text-muted-foreground mt-1">
            <p>Agent: {chat.agentId}</p>
            <p>Created: {new Date(chat.createdAt).toLocaleString()}</p>
            <p>
              {chat.interactions.length} interaction
              {chat.interactions.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
        {untrustedCount > 0 && (
          <Badge variant="destructive">{untrustedCount} Untrusted</Badge>
        )}
      </div>
      <Divider />
      <div className="px-2">
        <ChatInteractions interactions={chat.interactions} />
      </div>
    </>
  );
}

function ChatInteractions({
  interactions,
}: {
  interactions: GetChatResponses["200"]["interactions"];
}) {
  return (
    <ChatBotDemo
      messages={interactions.map(mapInteractionToUiMessage)}
      containerClassName="h-[75vh]"
    />
  );
}

function mapInteractionToUiMessage(
  interaction: GetChatResponses["200"]["interactions"][number],
): PartialUIMessage {
  const content = interaction.content.content;

  // Map content to UIMessage parts
  const parts: PartialUIMessage["parts"] = [];

  // Handle assistant messages with tool calls
  if (
    interaction.content.role === "assistant" &&
    "tool_calls" in interaction.content
  ) {
    const toolCalls = interaction.content.tool_calls;

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
  // Handle tool response messages
  else if (interaction.content.role === "tool") {
    const toolContent = interaction.content.content;
    const toolCallId = interaction.content.tool_call_id;

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
  if (
    interaction.content.role === "developer" ||
    interaction.content.role === "system"
  ) {
    role = "system";
  } else if (
    interaction.content.role === "function" ||
    interaction.content.role === "tool"
  ) {
    role = "assistant";
  } else {
    role = interaction.content.role;
  }

  return {
    id: interaction.id,
    role,
    parts,
    metadata: {
      trusted: interaction.trusted,
      blocked: interaction.blocked,
      reason: interaction.reason ?? undefined,
    },
  };
}
