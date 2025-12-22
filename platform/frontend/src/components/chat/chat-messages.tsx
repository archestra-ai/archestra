import type { UIMessage } from "@ai-sdk/react";
import type { ChatStatus, DynamicToolUIPart, ToolUIPart } from "ai";
import Image from "next/image";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Response } from "@/components/ai-elements/response";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { useUpdateChatMessage } from "@/lib/chat-message.query";
import { EditableAssistantMessage } from "./editable-assistant-message";
import { EditableUserMessage } from "./editable-user-message";
import { InlineChatError } from "./inline-chat-error";

interface ChatMessagesProps {
  conversationId: string | undefined;
  messages: UIMessage[];
  hideToolCalls?: boolean;
  status: ChatStatus;
  isLoadingConversation?: boolean;
  onMessagesUpdate?: (messages: UIMessage[]) => void;
  onUserMessageEdit?: (
    editedMessage: UIMessage,
    updatedMessages: UIMessage[],
    editedPartIndex: number,
  ) => void;
  error?: Error | null;
}

// Type guards for tool parts
// biome-ignore lint/suspicious/noExplicitAny: AI SDK message parts have dynamic structure
function isToolPart(part: any): part is {
  type: string;
  state?: string;
  toolCallId?: string;
  // biome-ignore lint/suspicious/noExplicitAny: Tool inputs are dynamic based on tool schema
  input?: any;
  // biome-ignore lint/suspicious/noExplicitAny: Tool outputs are dynamic based on tool execution
  output?: any;
  errorText?: string;
} {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    (part.type?.startsWith("tool-") || part.type === "dynamic-tool")
  );
}

export function ChatMessages({
  conversationId,
  messages,
  hideToolCalls = false,
  status,
  isLoadingConversation = false,
  onMessagesUpdate,
  onUserMessageEdit,
  error = null,
}: ChatMessagesProps) {
  const isStreamingStalled = useStreamingStallDetection(messages, status);
  // Track editing by messageId-partIndex to support multiple text parts per message
  const [editingPartKey, setEditingPartKey] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  // Initialize mutation hook with conversationId (use empty string as fallback for hook rules)
  const updateChatMessageMutation = useUpdateChatMessage(conversationId || "");

  const handleStartEdit = (partKey: string, messageId?: string) => {
    setEditingPartKey(partKey);
    // Always reset editingMessageId to prevent stale state when switching
    // between editing user messages (which pass messageId) and assistant messages (which don't)
    setEditingMessageId(messageId ?? null);
  };

  const handleCancelEdit = () => {
    setEditingPartKey(null);
    setEditingMessageId(null);
  };

  const handleSaveAssistantMessage = async (
    messageId: string,
    partIndex: number,
    newText: string,
  ) => {
    const data = await updateChatMessageMutation.mutateAsync({
      messageId,
      partIndex,
      text: newText,
    });

    // Update local state to reflect the change immediately
    if (onMessagesUpdate && data?.messages) {
      onMessagesUpdate(data.messages as UIMessage[]);
    }
  };

  const handleSaveUserMessage = async (
    messageId: string,
    partIndex: number,
    newText: string,
  ) => {
    const data = await updateChatMessageMutation.mutateAsync({
      messageId,
      partIndex,
      text: newText,
      deleteSubsequentMessages: true,
    });

    // Don't call onMessagesUpdate here - let onUserMessageEdit handle state
    // to avoid race condition with old messages reappearing

    // Find the edited message and trigger regeneration
    // Pass the partIndex so the caller knows which specific part was edited
    if (onUserMessageEdit && data?.messages) {
      const editedMessage = (data.messages as UIMessage[]).find(
        (m) => m.id === messageId,
      );
      if (editedMessage) {
        onUserMessageEdit(
          editedMessage,
          data.messages as UIMessage[],
          partIndex,
        );
      }
    }
  };

  if (messages.length === 0) {
    // Don't show "start conversation" message while loading - prevents flash of empty state
    if (isLoadingConversation) {
      return null;
    }

    return (
      <div className="flex-1 flex h-full items-center justify-center text-center text-muted-foreground">
        <p className="text-sm">Start a conversation by sending a message</p>
      </div>
    );
  }

  // Find the index of the message being edited
  const editingMessageIndex = editingMessageId
    ? messages.findIndex((m) => m.id === editingMessageId)
    : -1;

  // Determine which assistant messages are the last in their consecutive sequence
  // An assistant message is "last in sequence" if:
  // 1. It's the last message overall, OR
  // 2. The next message is NOT an assistant message
  const isLastInAssistantSequence = messages.map((message, idx) => {
    if (message.role !== "assistant") {
      return false;
    }

    // Check if this is the last message overall
    if (idx === messages.length - 1) {
      return true;
    }

    // Check if the next message is not an assistant message
    const nextMessage = messages[idx + 1];
    return nextMessage.role !== "assistant";
  });

  return (
    <Conversation className="h-full">
      <ConversationContent>
        <div className="max-w-4xl mx-auto">
          {messages.map((message, idx) => {
            // Hide messages below the one being edited (for user messages only)
            if (
              editingMessageIndex !== -1 &&
              idx > editingMessageIndex &&
              editingPartKey?.startsWith(messages[editingMessageIndex].id)
            ) {
              return null;
            }

            return (
              <div key={message.id || idx}>
                {message.parts?.map((part, i) => {
                  // Skip tool result parts that immediately follow a tool invocation with same toolCallId
                  if (
                    isToolPart(part) &&
                    part.state === "output-available" &&
                    i > 0
                  ) {
                    const prevPart = message.parts?.[i - 1];
                    if (
                      isToolPart(prevPart) &&
                      prevPart.state === "input-available" &&
                      prevPart.toolCallId === part.toolCallId
                    ) {
                      return null;
                    }
                  }

                  // Hide tool calls if hideToolCalls is true
                  if (
                    hideToolCalls &&
                    isToolPart(part) &&
                    (part.type?.startsWith("tool-") ||
                      part.type === "dynamic-tool")
                  ) {
                    return null;
                  }

                  switch (part.type) {
                    case "text": {
                      const partKey = `${message.id}-${i}`;

                      // Use editable component for assistant messages
                      if (message.role === "assistant") {
                        // Only show actions if this is the last assistant message in sequence
                        // AND this is the last text part in the message
                        const isLastAssistantInSequence =
                          isLastInAssistantSequence[idx];

                        // Find the last text part index in this message
                        let lastTextPartIndex = -1;
                        for (let j = message.parts.length - 1; j >= 0; j--) {
                          if (message.parts[j].type === "text") {
                            lastTextPartIndex = j;
                            break;
                          }
                        }

                        const isLastTextPart = i === lastTextPartIndex;
                        const showActions =
                          isLastAssistantInSequence &&
                          isLastTextPart &&
                          status !== "streaming";

                        return (
                          <Fragment key={partKey}>
                            <EditableAssistantMessage
                              messageId={message.id}
                              partIndex={i}
                              partKey={partKey}
                              text={part.text}
                              isEditing={editingPartKey === partKey}
                              showActions={showActions}
                              onStartEdit={handleStartEdit}
                              onCancelEdit={handleCancelEdit}
                              onSave={handleSaveAssistantMessage}
                            />
                          </Fragment>
                        );
                      }

                      // Use editable component for user messages
                      if (message.role === "user") {
                        return (
                          <Fragment key={partKey}>
                            <EditableUserMessage
                              messageId={message.id}
                              partIndex={i}
                              partKey={partKey}
                              text={part.text}
                              isEditing={editingPartKey === partKey}
                              onStartEdit={handleStartEdit}
                              onCancelEdit={handleCancelEdit}
                              onSave={handleSaveUserMessage}
                            />
                          </Fragment>
                        );
                      }

                      // Regular rendering for system messages
                      return (
                        <Fragment key={`${message.id}-${i}`}>
                          <Message from={message.role}>
                            <MessageContent>
                              {message.role === "system" && (
                                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                  System Prompt
                                </div>
                              )}
                              <Response>{part.text}</Response>
                            </MessageContent>
                          </Message>
                        </Fragment>
                      );
                    }

                    case "reasoning":
                      return (
                        <Reasoning
                          key={`${message.id}-${i}`}
                          className="w-full"
                        >
                          <ReasoningTrigger />
                          <ReasoningContent>{part.text}</ReasoningContent>
                        </Reasoning>
                      );

                    case "dynamic-tool": {
                      if (!isToolPart(part)) return null;
                      const toolName = part.toolName;

                      // Look ahead for tool result (same tool call ID)
                      let toolResultPart = null;
                      const nextPart = message.parts?.[i + 1];
                      if (
                        nextPart &&
                        isToolPart(nextPart) &&
                        nextPart.type === "dynamic-tool" &&
                        nextPart.state === "output-available" &&
                        nextPart.toolCallId === part.toolCallId
                      ) {
                        toolResultPart = nextPart;
                      }

                      return (
                        <MessageTool
                          part={part}
                          key={`${message.id}-${i}`}
                          toolResultPart={toolResultPart}
                          toolName={toolName}
                        />
                      );
                    }

                    default: {
                      // Handle tool invocations (type is "tool-{toolName}")
                      if (isToolPart(part) && part.type?.startsWith("tool-")) {
                        const toolName = part.type.replace("tool-", "");

                        // Look ahead for tool result (same tool call ID)
                        // biome-ignore lint/suspicious/noExplicitAny: Tool result structure varies by tool type
                        let toolResultPart: any = null;
                        const nextPart = message.parts?.[i + 1];
                        if (
                          nextPart &&
                          isToolPart(nextPart) &&
                          nextPart.type?.startsWith("tool-") &&
                          nextPart.state === "output-available" &&
                          nextPart.toolCallId === part.toolCallId
                        ) {
                          toolResultPart = nextPart;
                        }

                        return (
                          <MessageTool
                            part={part}
                            key={`${message.id}-${i}`}
                            toolResultPart={toolResultPart}
                            toolName={toolName}
                          />
                        );
                      }

                      // Skip step-start and other non-renderable parts
                      return null;
                    }
                  }
                })}
              </div>
            );
          })}
          {/* Inline error display */}
          {error && <InlineChatError error={error} />}
          {(status === "submitted" ||
            (status === "streaming" && isStreamingStalled)) && (
            <Message from="assistant">
              <Image
                src={"/logo.png"}
                alt="Loading logo"
                width={40}
                height={40}
                className="object-contain h-8 w-auto animate-[bounce_700ms_ease_200ms_infinite]"
              />
            </Message>
          )}
        </div>
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

// Custom hook to detect when streaming has stalled (>500ms without updates)
function useStreamingStallDetection(
  messages: UIMessage[],
  status: ChatStatus,
): boolean {
  const lastUpdateTimeRef = useRef<number>(Date.now());
  const [isStreamingStalled, setIsStreamingStalled] = useState(false);

  // Update last update time when messages change
  // biome-ignore lint/correctness/useExhaustiveDependencies: we need to react to messages change here
  useEffect(() => {
    if (status === "streaming") {
      lastUpdateTimeRef.current = Date.now();
      setIsStreamingStalled(false);
    }
  }, [messages, status]);

  // Check periodically if streaming has stalled
  useEffect(() => {
    if (status !== "streaming") {
      setIsStreamingStalled(false);
      return;
    }

    const interval = setInterval(() => {
      const timeSinceLastUpdate = Date.now() - lastUpdateTimeRef.current;
      if (timeSinceLastUpdate > 1_000) {
        setIsStreamingStalled(true);
      } else {
        setIsStreamingStalled(false);
      }
    }, 100); // Check every 100ms

    return () => clearInterval(interval);
  }, [status]);

  return isStreamingStalled;
}

function MessageTool({
  part,
  toolResultPart,
  toolName,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  toolName: string;
}) {
  const outputError = toolResultPart
    ? tryToExtractErrorFromOutput(toolResultPart.output)
    : tryToExtractErrorFromOutput(part.output);
  const errorText = toolResultPart
    ? (toolResultPart.errorText ?? outputError)
    : (part.errorText ?? outputError);

  const hasInput = part.input && Object.keys(part.input).length > 0;
  const hasContent = Boolean(
    hasInput ||
      (toolResultPart && Boolean(toolResultPart.output)) ||
      (!toolResultPart && Boolean(part.output)),
  );

  return (
    <Tool className={hasContent ? "cursor-pointer" : ""}>
      <ToolHeader
        type={`tool-${toolName}`}
        state={getHeaderState({
          state: part.state || "input-available",
          toolResultPart,
          errorText,
        })}
        errorText={errorText}
        isCollapsible={hasContent}
      />
      <ToolContent>
        {hasInput ? <ToolInput input={part.input} /> : null}
        {toolResultPart && (
          <ToolOutput
            label={errorText ? "Error" : "Result"}
            output={toolResultPart.output}
            errorText={errorText}
          />
        )}
        {!toolResultPart && Boolean(part.output) && (
          <ToolOutput
            label={errorText ? "Error" : "Result"}
            output={part.output}
            errorText={errorText}
          />
        )}
      </ToolContent>
    </Tool>
  );
}

const tryToExtractErrorFromOutput = (output: unknown) => {
  try {
    if (typeof output !== "string") return undefined;
    const json = JSON.parse(output);
    return typeof json.error === "string" ? json.error : undefined;
  } catch (_error) {
    return undefined;
  }
};
const getHeaderState = ({
  state,
  toolResultPart,
  errorText,
}: {
  state: ToolUIPart["state"] | DynamicToolUIPart["state"];
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  errorText: string | undefined;
}) => {
  if (errorText) return "output-error";
  if (toolResultPart) return "output-available";
  return state;
};
