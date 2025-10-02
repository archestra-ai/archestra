"use client";

import { Suspense } from "react";
import type { GetChatResponses } from "shared/api-client";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import ChatBotDemo, { type PartialUIMessage } from "@/components/chatbot-demo";
import { LoadingSpinner } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useChat } from "@/lib/chat.query";

export function ChatPage({
  initialData,
  id,
}: {
  initialData?: GetChatResponses["200"];
  id: string;
}) {
  return (
    <div className="container mx-auto p-6 max-w-6xl">
      <h1 className="text-3xl font-bold mb-6">Chat: {id}</h1>
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

  const taintedCount = chat.interactions.filter((i) => i.tainted).length;

  return (
    <Card key={chat.id}>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-lg">Chat {chat.id}</CardTitle>
            <div className="text-sm text-muted-foreground mt-1">
              <p>Agent: {chat.agentId}</p>
              <p>Created: {new Date(chat.createdAt).toLocaleString()}</p>
              <p>
                {chat.interactions.length} interaction
                {chat.interactions.length !== 1 ? "s" : ""}
              </p>
            </div>
          </div>
          {taintedCount > 0 && (
            <Badge variant="destructive">{taintedCount} Tainted</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <ChatInteractions interactions={chat.interactions} />
          {/* {chat.interactions.map((interaction) => (
            <ChatInteraction key={interaction.id} interaction={interaction} />
          ))} */}
        </div>
      </CardContent>
    </Card>
  );
}

function ChatInteractions({
  interactions,
}: {
  interactions: GetChatResponses["200"]["interactions"];
}) {
  return <ChatBotDemo messages={interactions.map(mapInteractionToUiMessage)} />;
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
      tainted: interaction.tainted,
      taintReason: interaction.taintReason ?? undefined,
    },
  };
}

function _ChatInteraction({
  interaction,
}: {
  interaction: GetChatResponses["200"]["interactions"][number];
}) {
  return (
    <div
      key={interaction.id}
      className={`p-3 rounded border ${
        interaction.tainted
          ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950"
          : "border-gray-200 dark:border-gray-800"
      }`}
    >
      <div className="flex items-start gap-2 mb-2">
        <Badge className={getRoleBadgeColor(interaction.content.role)}>
          {interaction.content.role}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {new Date(interaction.createdAt).toLocaleString()}
        </span>
        {interaction.tainted && (
          <Badge variant="destructive" className="text-xs">
            Tainted
          </Badge>
        )}
      </div>

      {interaction.content.role === "assistant" &&
        interaction.content.tool_calls && (
          <div className="mb-2 text-sm">
            <p className="font-semibold">Tool Calls:</p>
            <div className="space-y-1 mt-1">
              {interaction.content.tool_calls.map((tc) => (
                <div
                  key={tc.id}
                  className="bg-muted p-2 rounded font-mono text-xs"
                >
                  {tc.type === "function" && (
                    <>
                      <span className="font-semibold">{tc.function.name}</span>(
                      {tc.function.arguments.substring(0, 100)}
                      {tc.function.arguments.length > 100 ? "..." : ""})
                    </>
                  )}
                  {tc.type === "custom" && (
                    <span className="font-semibold">
                      [Custom] {tc.custom.name}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

      <div className="text-sm">
        {formatContent(interaction.content.content)}
      </div>

      {interaction.tainted && interaction.taintReason && (
        <div className="mt-2 text-xs text-red-700 dark:text-red-400 italic">
          Taint reason: {interaction.taintReason}
        </div>
      )}
    </div>
  );
}

const getRoleBadgeColor = (role: string) => {
  switch (role) {
    case "user":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200";
    case "assistant":
      return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
    case "tool":
      return "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200";
    case "system":
      return "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200";
    default:
      return "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200";
  }
};

// biome-ignore lint/suspicious/noExplicitAny: this can legitimately be anything..
const formatContent = (content: any): string => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "image_url") return "[Image]";
        if (part.type === "input_audio") return "[Audio]";
        if (part.type === "file")
          return `[File: ${part.file?.filename || "unknown"}]`;
        return "";
      })
      .join(" ");
  }
  return "";
};
