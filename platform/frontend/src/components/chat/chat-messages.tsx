import type { UIMessage } from "@ai-sdk/react";
import type { ChatStatus, DynamicToolUIPart, ToolUIPart } from "ai";
import Image from "next/image";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { parsePolicyDenied } from "@/lib/llmProviders/common";
import { hasThinkingTags, parseThinkingTags } from "@/lib/parse-thinking";
import { cn } from "@/lib/utils";
import { extractFileAttachments, hasTextPart } from "./chat-messages.utils";
import { EditableAssistantMessage } from "./editable-assistant-message";
import { EditableUserMessage } from "./editable-user-message";
import { InlineChatError } from "./inline-chat-error";
import { PolicyDeniedTool } from "./policy-denied-tool";
import { TodoWriteTool } from "./todo-write-tool";

interface ChatMessagesProps {
  conversationId: string | undefined;
  agentId?: string;
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
  // Empty state customization
  agentName?: string;
  suggestedPrompt?: string | null;
  onSuggestedPromptClick?: () => void;
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
  agentId,
  agentName,
  suggestedPrompt,
  onSuggestedPromptClick,
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

  // Debounce resize mode change when exiting edit mode to let DOM settle
  const isEditing = editingPartKey !== null;
  const [instantResize, setInstantResize] = useState(false);
  useLayoutEffect(() => {
    if (isEditing) {
      setInstantResize(true);
    } else {
      const timeout = setTimeout(() => setInstantResize(false), 100);
      return () => clearTimeout(timeout);
    }
  }, [isEditing]);

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

    // Unified empty state for both new chat and existing chat with no messages
    if (agentName) {
      return (
        <div className="flex items-center justify-center h-full relative">
          {/* Custom bent arrow pointing to agent selector */}
          <svg
            className="fixed pointer-events-none z-50"
            width="600"
            height="400"
            style={{
              top: "85px",
              left: "248px",
            }}
            aria-hidden="true"
          >
            <title>Arrow pointing to agent selector</title>
            <defs>
              <marker
                id="arrowhead"
                markerWidth="10"
                markerHeight="7"
                refX="9"
                refY="3.5"
                orient="auto"
              >
                <polygon
                  points="0 0, 10 3.5, 0 7"
                  fill="rgb(156, 163, 175)"
                  strokeWidth="0"
                  opacity="0.6"
                />
              </marker>
            </defs>
            <path
              d="M 350 340 Q 300 340 250 340 L 100 340 Q 60 340 60 300 L 60 5"
              stroke="rgb(156, 163, 175)"
              strokeWidth="2"
              fill="none"
              strokeDasharray="5,5"
              markerEnd="url(#arrowhead)"
              opacity="0.5"
            />
          </svg>

          <div className="text-center space-y-6 max-w-2xl px-4 relative">
            <p className="text-lg text-muted-foreground">
              Chat with{" "}
              <span className="font-medium text-foreground">{agentName}</span>{" "}
              agent,
              <br />
              or{" "}
              <a
                href="/agents?create=true"
                className="text-primary hover:underline"
              >
                create a new one
              </a>
            </p>
            {suggestedPrompt && onSuggestedPromptClick && (
              <button
                type="button"
                onClick={onSuggestedPromptClick}
                className="w-full text-left cursor-pointer hover:opacity-80 transition-opacity"
              >
                <Message from="assistant" className="max-w-none justify-center">
                  <MessageContent className="max-w-none text-left">
                    <Response>{suggestedPrompt}</Response>
                  </MessageContent>
                </Message>
              </button>
            )}
          </div>
        </div>
      );
    }

    // Fallback for when no agent name is provided
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

  const isResponseInProgress = status === "streaming" || status === "submitted";

  return (
    <Conversation
      className="h-full"
      resize={instantResize ? "instant" : "smooth"}
    >
      <ConversationContent>
        <div className="max-w-4xl mx-auto">
          {messages.map((message, idx) => {
            const isDimmed =
              editingMessageIndex !== -1 && idx > editingMessageIndex;
            return (
              <div
                key={message.id || idx}
                className={cn(isDimmed && "opacity-40 transition-opacity")}
              >
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

                      // Anthropic sends policy denials as text blocks (see MessageTool for OpenAI path)
                      const policyDenied = parsePolicyDenied(part.text);
                      if (policyDenied) {
                        return (
                          <PolicyDeniedTool
                            key={partKey}
                            policyDenied={policyDenied}
                            {...(agentId
                              ? { editable: true, profileId: agentId }
                              : { editable: false })}
                          />
                        );
                      }

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

                        // Check for <think> tags (used by Qwen and similar models)
                        if (hasThinkingTags(part.text)) {
                          const parsedParts = parseThinkingTags(part.text);
                          return (
                            <Fragment key={partKey}>
                              {parsedParts.map((parsedPart, parsedIdx) => {
                                const parsedKey = `${partKey}-parsed-${parsedIdx}`;
                                if (parsedPart.type === "reasoning") {
                                  return (
                                    <Reasoning
                                      key={parsedKey}
                                      className="w-full"
                                    >
                                      <ReasoningTrigger />
                                      <ReasoningContent>
                                        {parsedPart.text}
                                      </ReasoningContent>
                                    </Reasoning>
                                  );
                                }
                                // Render text parts - show actions only on the last text part
                                const isLastParsedTextPart =
                                  parsedIdx ===
                                  parsedParts.length -
                                    1 -
                                    [...parsedParts]
                                      .reverse()
                                      .findIndex((p) => p.type === "text");
                                return (
                                  <EditableAssistantMessage
                                    key={parsedKey}
                                    messageId={message.id}
                                    partIndex={i}
                                    partKey={partKey}
                                    text={parsedPart.text}
                                    isEditing={editingPartKey === partKey}
                                    showActions={
                                      showActions && isLastParsedTextPart
                                    }
                                    editDisabled={isResponseInProgress}
                                    onStartEdit={handleStartEdit}
                                    onCancelEdit={handleCancelEdit}
                                    onSave={handleSaveAssistantMessage}
                                  />
                                );
                              })}
                            </Fragment>
                          );
                        }

                        return (
                          <Fragment key={partKey}>
                            <EditableAssistantMessage
                              messageId={message.id}
                              partIndex={i}
                              partKey={partKey}
                              text={part.text}
                              isEditing={editingPartKey === partKey}
                              showActions={showActions}
                              editDisabled={isResponseInProgress}
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
                              editDisabled={isResponseInProgress}
                              attachments={extractFileAttachments(
                                message.parts,
                              )}
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

                    case "file": {
                      // User file attachments are normally rendered inside EditableUserMessage
                      // But if there's no text part, we need to render them here
                      if (message.role === "user") {
                        // If there's a text part, files will be rendered with EditableUserMessage
                        if (hasTextPart(message.parts)) {
                          return null;
                        }

                        // For file-only messages, render on the first file part only
                        const isFirstFilePart =
                          message.parts?.findIndex((p) => p.type === "file") ===
                          i;

                        if (!isFirstFilePart) {
                          return null;
                        }

                        const partKey = `${message.id}-${i}`;

                        return (
                          <Fragment key={partKey}>
                            <EditableUserMessage
                              messageId={message.id}
                              partIndex={i}
                              partKey={partKey}
                              text=""
                              isEditing={editingPartKey === partKey}
                              editDisabled={isResponseInProgress}
                              attachments={extractFileAttachments(
                                message.parts,
                              )}
                              onStartEdit={handleStartEdit}
                              onCancelEdit={handleCancelEdit}
                              onSave={handleSaveUserMessage}
                            />
                          </Fragment>
                        );
                      }

                      // Render file attachments for assistant/system messages
                      const filePart = part as {
                        type: "file";
                        url: string;
                        mediaType: string;
                        filename?: string;
                      };
                      const isImage = filePart.mediaType?.startsWith("image/");
                      const isVideo = filePart.mediaType?.startsWith("video/");
                      const isPdf = filePart.mediaType === "application/pdf";

                      return (
                        <div
                          key={`${message.id}-${i}`}
                          className="py-1 -mt-2 flex justify-start"
                        >
                          <div className="max-w-sm">
                            {isImage && (
                              <img
                                src={filePart.url}
                                alt={filePart.filename || "Attached image"}
                                className="max-w-full max-h-64 rounded-lg object-contain"
                              />
                            )}
                            {isVideo && (
                              <video
                                src={filePart.url}
                                controls
                                className="max-w-full max-h-64 rounded-lg"
                              >
                                <track kind="captions" />
                              </video>
                            )}
                            {isPdf && (
                              <div className="flex items-center gap-2 text-sm rounded-lg border bg-muted/50 p-2">
                                <svg
                                  className="h-6 w-6 text-red-500"
                                  fill="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <title>PDF Document</title>
                                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4zm-3 9h2v2H10v-2zm0 3h2v2H10v-2zm-3-3h2v2H7v-2zm0 3h2v2H7v-2z" />
                                </svg>
                                <span className="font-medium truncate">
                                  {filePart.filename || "PDF Document"}
                                </span>
                              </div>
                            )}
                            {!isImage && !isVideo && !isPdf && (
                              <div className="flex items-center gap-2 text-sm rounded-lg border bg-muted/50 p-2">
                                <svg
                                  className="h-5 w-5 text-muted-foreground"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <title>File Attachment</title>
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                                  />
                                </svg>
                                <span className="truncate">
                                  {filePart.filename || "Attached file"}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    }

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
                          agentId={agentId}
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
                            agentId={agentId}
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
  agentId,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  toolName: string;
  agentId?: string;
}) {
  const outputError = toolResultPart
    ? tryToExtractErrorFromOutput(toolResultPart.output)
    : tryToExtractErrorFromOutput(part.output);
  const errorText = toolResultPart
    ? (toolResultPart.errorText ?? outputError)
    : (part.errorText ?? outputError);

  // OpenAI sends policy denials as tool errors (see case "text" above for Anthropic path)
  if (errorText) {
    const policyDenied = parsePolicyDenied(errorText);
    if (policyDenied) {
      return (
        <PolicyDeniedTool
          policyDenied={policyDenied}
          {...(agentId
            ? { editable: true, profileId: agentId }
            : { editable: false })}
        />
      );
    }
  }

  // Check if this is the todo_write tool from Archestra
  if (toolName === "archestra__todo_write") {
    return (
      <TodoWriteTool
        part={part}
        toolResultPart={toolResultPart}
        errorText={errorText}
      />
    );
  }

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
