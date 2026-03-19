import type { UIMessage } from "@ai-sdk/react";
import {
  SWAP_AGENT_FAILED_POKE_TEXT,
  SWAP_AGENT_POKE_PREFIX,
  SWAP_AGENT_POKE_TEXT,
  SWAP_TO_DEFAULT_AGENT_POKE_TEXT,
  TOOL_SWAP_AGENT_FULL_NAME,
  TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME,
  TOOL_TODO_WRITE_FULL_NAME,
} from "@shared";
import type { ChatStatus, DynamicToolUIPart, ToolUIPart } from "ai";
import { CheckCircleIcon, ClockIcon } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  ToolErrorDetails,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { useHasPermissions, useSession } from "@/lib/auth.query";
import { useProfileToolsWithIds } from "@/lib/chat.query";
import { useUpdateChatMessage } from "@/lib/chat-message.query";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import {
  extractCatalogIdFromInstallUrl,
  extractIdsFromReauthUrl,
  parseAuthRequired,
  parseExpiredAuth,
  parsePolicyDenied,
} from "@/lib/llmProviders/common";
import { useMcpInstallOrchestrator } from "@/lib/mcp-install-orchestrator.hook";
import { useOrganization } from "@/lib/organization.query";
import { hasThinkingTags, parseThinkingTags } from "@/lib/parse-thinking";
import { cn } from "@/lib/utils";
import { AuthRequiredTool } from "./auth-required-tool";
import {
  extractFileAttachments,
  filterOptimisticToolCalls,
  hasTextPart,
} from "./chat-messages.utils";
import {
  getToolErrorText,
  getToolHeaderState,
  isCompactEligible,
} from "./chat-tools-display.utils";
import { CompactToolGroup } from "./compact-tool-call";
import { EditableAssistantMessage } from "./editable-assistant-message";
import { EditableUserMessage } from "./editable-user-message";
import { ExpiredAuthTool } from "./expired-auth-tool";
import { InlineChatError } from "./inline-chat-error";
import { hasKnowledgeBaseToolCall } from "./knowledge-graph-citations";
import { McpInstallDialogs } from "./mcp-install-dialogs";
import { PolicyDeniedTool } from "./policy-denied-tool";
import { TodoWriteTool } from "./todo-write-tool";
import { ToolErrorLogsButton } from "./tool-error-logs-button";
import { ToolStatusRow } from "./tool-status-row";

interface ChatMessagesProps {
  conversationId: string | undefined;
  agentId?: string;
  messages: UIMessage[];
  status: ChatStatus;
  optimisticToolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
  }>;
  isLoadingConversation?: boolean;
  onMessagesUpdate?: (messages: UIMessage[]) => void;
  onUserMessageEdit?: (
    editedMessage: UIMessage,
    updatedMessages: UIMessage[],
    editedPartIndex: number,
  ) => void;
  error?: Error | null;
  /** Callback for tool approval responses (approve/deny) */
  onToolApprovalResponse?: (params: {
    id: string;
    approved: boolean;
    reason?: string;
  }) => void;
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
  messages,
  status,
  optimisticToolCalls = [],
  isLoadingConversation = false,
  onMessagesUpdate,
  onUserMessageEdit,
  error = null,
  onToolApprovalResponse,
}: ChatMessagesProps) {
  const isStreamingStalled = useStreamingStallDetection(messages, status);
  const { data: session } = useSession();
  const isDebugging = session?.user?.name?.endsWith("(debugging)") ?? false;

  // Track editing by messageId-partIndex to support multiple text parts per message
  const [editingPartKey, setEditingPartKey] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const { data: canExpandToolCalls } = useHasPermissions({
    chatExpandToolCalls: ["enable"],
  });
  const { data: canReadMcpRegistry } = useHasPermissions({
    mcpRegistry: ["read"],
  });
  const { data: organization } = useOrganization();
  const orchestrator = useMcpInstallOrchestrator();

  // Build tool name → icon map from agent tools + catalog data
  const { data: agentTools } = useProfileToolsWithIds(agentId);
  const { data: catalogItems } = useInternalMcpCatalog({
    enabled: !!agentId && !!canReadMcpRegistry,
  });
  const toolIconMap = useMemo(() => {
    const map = new Map<string, { icon?: string | null; catalogId?: string }>();
    if (!agentTools || !catalogItems) return map;
    const catalogMap = new Map(catalogItems.map((c) => [c.id, c]));
    for (const tool of agentTools) {
      if (tool.catalogId) {
        const catalog = catalogMap.get(tool.catalogId);
        if (catalog) {
          map.set(tool.name, {
            icon: catalog.icon,
            catalogId: catalog.id,
          });
        }
      }
    }
    return map;
  }, [agentTools, catalogItems]);

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

  const pendingToolCalls = useMemo(
    () => filterOptimisticToolCalls(messages, optimisticToolCalls),
    [messages, optimisticToolCalls],
  );

  const isResponseInProgress = status === "streaming" || status === "submitted";

  // Only auto-scroll on content resize during streaming.
  // When idle, user interactions like expanding tool calls should not
  // trigger scroll — returning the current scrollTop keeps position stable.
  const preventResizeScroll = useCallback(
    (_target: number, { scrollElement }: { scrollElement: HTMLElement }) =>
      scrollElement.scrollTop,
    [],
  );

  if (messages.length === 0) {
    // Don't show "start conversation" message while loading - prevents flash of empty state
    if (isLoadingConversation) {
      return null;
    }
    return null;
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
    <Conversation
      className="h-full"
      resize={instantResize ? "instant" : "smooth"}
      targetScrollTop={isResponseInProgress ? undefined : preventResizeScroll}
    >
      <ConversationContent>
        <div className="max-w-4xl mx-auto relative pb-8">
          {messages.map((message, idx) => {
            // Hide the auto-poke message sent after agent swap
            if (!isDebugging && isSwapAgentPokeMessage(message)) return null;

            const isDimmed =
              editingMessageIndex !== -1 && idx > editingMessageIndex;
            return (
              <div
                key={message.id || idx}
                className={cn(isDimmed && "opacity-40 transition-opacity")}
              >
                {(() => {
                  const { groupMap, consumedIndices } = identifyCompactGroups(
                    message.parts,
                  );
                  const partKeyTracker = new Map<string, number>();
                  return message.parts?.map((part, i) => {
                    const partKey = getMessagePartKey(
                      message.id,
                      part,
                      partKeyTracker,
                    );
                    // Render compact group at its start index
                    if (groupMap.has(i)) {
                      const group = groupMap.get(i);
                      if (!group) return null;
                      return (
                        <CompactToolGroup
                          key={getCompactGroupKey(message.id, group.entries)}
                          tools={group.entries.map((entry) => ({
                            key: getToolEntryKey(message.id, entry),
                            toolName: entry.toolName,
                            part: entry.part,
                            toolResultPart: entry.toolResultPart,
                            errorText: entry.errorText,
                          }))}
                          toolIconMap={toolIconMap}
                          canExpandToolCalls={canExpandToolCalls}
                          onToolApprovalResponse={onToolApprovalResponse}
                        />
                      );
                    }

                    // Skip parts consumed by compact groups
                    if (consumedIndices.has(i)) {
                      return null;
                    }

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

                    switch (part.type) {
                      case "text": {
                        // Skip empty text parts from assistant messages.
                        // OpenAI-compatible providers (Ollama, vLLM, etc.) may send empty content
                        // alongside tool calls, which the AI SDK converts into an empty text part.
                        if (!part.text && message.role === "assistant") {
                          return null;
                        }

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
                          // Only show streaming animation if this text part is
                          // actually the last part in the message. When tool
                          // parts follow the text, the text is already complete
                          // even though status is still "streaming".
                          const isLastPartInMessage =
                            i === message.parts.length - 1;
                          const isStreamingThisPart =
                            status === "streaming" &&
                            idx === messages.length - 1 &&
                            isLastTextPart &&
                            isLastPartInMessage;
                          const showActions =
                            isLastAssistantInSequence &&
                            isLastTextPart &&
                            status !== "streaming";
                          // Show citations on the last text part of the last
                          // assistant message, only after streaming completes
                          // to avoid citations jumping between messages.
                          let citationParts: typeof message.parts | undefined;
                          if (
                            isLastAssistantInSequence &&
                            isLastTextPart &&
                            !isResponseInProgress
                          ) {
                            if (hasKnowledgeBaseToolCall(message.parts ?? [])) {
                              citationParts = message.parts;
                            } else {
                              // Search backwards for KB tool calls within the same
                              // assistant turn — stop at the next user message to
                              // avoid showing stale citations from prior turns.
                              for (
                                let prevIdx = idx - 1;
                                prevIdx >= 0;
                                prevIdx--
                              ) {
                                const prev = messages[prevIdx];
                                if (prev.role === "user") break;
                                if (
                                  prev.role === "assistant" &&
                                  hasKnowledgeBaseToolCall(prev.parts ?? [])
                                ) {
                                  citationParts = prev.parts;
                                  break;
                                }
                              }
                            }
                          }

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
                                      citationParts={
                                        isLastParsedTextPart
                                          ? citationParts
                                          : undefined
                                      }
                                      isStreaming={
                                        isStreamingThisPart &&
                                        isLastParsedTextPart
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
                                citationParts={citationParts}
                                isStreaming={isStreamingThisPart}
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
                          <Fragment key={partKey}>
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
                          <Reasoning key={partKey} className="w-full">
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
                            message.parts?.findIndex(
                              (p) => p.type === "file",
                            ) === i;

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
                        const isImage =
                          filePart.mediaType?.startsWith("image/");
                        const isVideo =
                          filePart.mediaType?.startsWith("video/");
                        const isPdf = filePart.mediaType === "application/pdf";

                        return (
                          <div
                            key={partKey}
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
                            key={partKey}
                            toolResultPart={toolResultPart}
                            toolName={toolName}
                            agentId={agentId}
                            isDebugging={isDebugging}
                            canExpandToolCalls={canExpandToolCalls}
                            onToolApprovalResponse={onToolApprovalResponse}
                            onInstallMcp={
                              orchestrator.triggerInstallByCatalogId
                            }
                            onReauthMcp={
                              orchestrator.triggerReauthByCatalogIdAndServerId
                            }
                          />
                        );
                      }

                      default: {
                        // Handle tool invocations (type is "tool-{toolName}")
                        if (
                          isToolPart(part) &&
                          part.type?.startsWith("tool-")
                        ) {
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
                              key={partKey}
                              toolResultPart={toolResultPart}
                              toolName={toolName}
                              agentId={agentId}
                              isDebugging={isDebugging}
                              canExpandToolCalls={canExpandToolCalls}
                              onToolApprovalResponse={onToolApprovalResponse}
                              onInstallMcp={
                                orchestrator.triggerInstallByCatalogId
                              }
                              onReauthMcp={
                                orchestrator.triggerReauthByCatalogIdAndServerId
                              }
                            />
                          );
                        }

                        // Skip step-start and other non-renderable parts
                        return null;
                      }
                    }
                  });
                })()}
                <SwapAgentDivider message={message} />
              </div>
            );
          })}
          {/* Inline error display */}
          {error && (
            <InlineChatError
              error={error}
              conversationId={conversationId}
              supportMessage={organization?.chatErrorSupportMessage}
            />
          )}
          {pendingToolCalls.map((toolCall) => (
            <MessageTool
              part={{
                type: "dynamic-tool",
                toolName: toolCall.toolName,
                toolCallId: toolCall.toolCallId,
                state: "input-available",
                input: toolCall.input,
              }}
              key={`optimistic-tool-${toolCall.toolCallId}`}
              toolResultPart={null}
              toolName={toolCall.toolName}
              agentId={agentId}
              isDebugging={isDebugging}
              canExpandToolCalls={canExpandToolCalls}
              onToolApprovalResponse={onToolApprovalResponse}
              onInstallMcp={orchestrator.triggerInstallByCatalogId}
              onReauthMcp={orchestrator.triggerReauthByCatalogIdAndServerId}
            />
          ))}
          {(status === "submitted" ||
            (status === "streaming" && isStreamingStalled)) && (
            <div className="absolute bottom-[-10] left-0">
              <Message from="assistant">
                <img
                  src={organization?.iconLogo || "/logo.png"}
                  alt="Loading logo"
                  className="object-contain h-6 w-auto animate-[bounce_700ms_ease_200ms_infinite]"
                />
              </Message>
            </div>
          )}
        </div>
      </ConversationContent>
      <ConversationScrollButton />
      <McpInstallDialogs orchestrator={orchestrator} />
    </Conversation>
  );
}

function getCompactGroupKey(
  messageId: string,
  entries: Array<{
    toolName: string;
    part: DynamicToolUIPart | ToolUIPart;
  }>,
): string {
  const signature = entries
    .map((entry) => entry.part.toolCallId ?? entry.toolName)
    .join(":");
  return `${messageId}-compact-${signature}`;
}

function getToolEntryKey(
  messageId: string,
  entry: {
    toolName: string;
    part: DynamicToolUIPart | ToolUIPart;
  },
): string {
  return `${messageId}-${entry.part.toolCallId ?? entry.toolName}`;
}

function getMessagePartKey(
  messageId: string,
  part: UIMessage["parts"][number],
  keyTracker: Map<string, number>,
): string {
  const signature = getMessagePartSignature(part);
  const occurrence = keyTracker.get(signature) ?? 0;
  keyTracker.set(signature, occurrence + 1);
  return `${messageId}-${signature}-${occurrence}`;
}

function getMessagePartSignature(part: UIMessage["parts"][number]): string {
  if (isToolPart(part)) {
    return `tool:${part.toolCallId ?? part.type}`;
  }

  switch (part.type) {
    case "text":
      return "text";
    case "reasoning":
      return "reasoning";
    case "file":
      return `file:${part.url}:${part.mediaType}:${part.filename ?? ""}`;
    default:
      return `part:${JSON.stringify(part)}`;
  }
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
  isDebugging,
  canExpandToolCalls = true,
  onToolApprovalResponse,
  onInstallMcp,
  onReauthMcp,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  toolName: string;
  agentId?: string;
  isDebugging?: boolean;
  canExpandToolCalls?: boolean;
  onToolApprovalResponse?: (params: {
    id: string;
    approved: boolean;
    reason?: string;
  }) => void;
  onInstallMcp?: (catalogId: string) => void;
  onReauthMcp?: (catalogId: string, serverId: string) => void;
}) {
  const errorText = getToolErrorText({ part, toolResultPart });

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

    const expiredAuth = parseExpiredAuth(errorText);
    if (expiredAuth) {
      const ids = extractIdsFromReauthUrl(expiredAuth.reauthUrl);
      return (
        <ExpiredAuthTool
          toolName={toolName}
          catalogName={expiredAuth.catalogName}
          reauthUrl={expiredAuth.reauthUrl}
          onReauth={
            onReauthMcp && ids.catalogId && ids.serverId
              ? () =>
                  onReauthMcp(ids.catalogId as string, ids.serverId as string)
              : undefined
          }
        />
      );
    }

    const authRequired = parseAuthRequired(errorText);
    if (authRequired) {
      const catalogId = extractCatalogIdFromInstallUrl(authRequired.installUrl);
      return (
        <AuthRequiredTool
          toolName={toolName}
          catalogName={authRequired.catalogName}
          installUrl={authRequired.installUrl}
          onInstall={
            onInstallMcp && catalogId
              ? () => onInstallMcp(catalogId)
              : undefined
          }
        />
      );
    }
  }

  // Also check tool output for auth-related patterns (tool errors returned as
  // successful results to avoid crashing the AI SDK stream still need the UI)
  const rawOutput = toolResultPart?.output ?? part.output;
  if (typeof rawOutput === "string") {
    const expiredAuth = parseExpiredAuth(rawOutput);
    if (expiredAuth) {
      const ids = extractIdsFromReauthUrl(expiredAuth.reauthUrl);
      return (
        <ExpiredAuthTool
          toolName={toolName}
          catalogName={expiredAuth.catalogName}
          reauthUrl={expiredAuth.reauthUrl}
          onReauth={
            onReauthMcp && ids.catalogId && ids.serverId
              ? () =>
                  onReauthMcp(ids.catalogId as string, ids.serverId as string)
              : undefined
          }
        />
      );
    }

    const authRequired = parseAuthRequired(rawOutput);
    if (authRequired) {
      const catalogId = extractCatalogIdFromInstallUrl(authRequired.installUrl);
      return (
        <AuthRequiredTool
          toolName={toolName}
          catalogName={authRequired.catalogName}
          installUrl={authRequired.installUrl}
          onInstall={
            onInstallMcp && catalogId
              ? () => onInstallMcp(catalogId)
              : undefined
          }
        />
      );
    }
  }

  // swap_agent / swap_to_default_agent are rendered as dividers after all message parts (see SwapAgentDivider below)
  // Show the raw tool call when the user's name ends with "(debugging)"
  if (
    !isDebugging &&
    (toolName === TOOL_SWAP_AGENT_FULL_NAME ||
      toolName === TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME)
  ) {
    return null;
  }

  if (toolName === TOOL_TODO_WRITE_FULL_NAME) {
    return (
      <TodoWriteTool
        part={part}
        toolResultPart={toolResultPart}
        errorText={errorText}
        onToolApprovalResponse={onToolApprovalResponse}
      />
    );
  }

  const isApprovalRequested = part.state === "approval-requested";
  const hasInput = part.input && Object.keys(part.input).length > 0;
  const hasContent = Boolean(
    hasInput ||
      errorText ||
      isApprovalRequested ||
      (toolResultPart && Boolean(toolResultPart.output)) ||
      (!toolResultPart && Boolean(part.output)),
  );

  // Show logs button for failed tool calls
  const logsButton = errorText ? (
    <ToolErrorLogsButton toolName={toolName} />
  ) : null;

  const isExpandable =
    hasContent && (canExpandToolCalls || isApprovalRequested);

  return (
    <Tool
      className={isExpandable ? "cursor-pointer" : ""}
      defaultOpen={isApprovalRequested}
    >
      <ToolHeader
        type={`tool-${toolName}`}
        state={getHeaderState({
          state: part.state || "input-available",
          toolResultPart,
          errorText,
        })}
        isCollapsible={isExpandable}
        actionButton={logsButton}
      />
      <ToolContent>
        {hasInput ? <ToolInput input={part.input} /> : null}
        {isApprovalRequested &&
          onToolApprovalResponse &&
          "approval" in part &&
          part.approval?.id && (
            <ToolStatusRow
              icon={
                <ClockIcon className="mt-0.5 size-4 flex-none text-amber-600" />
              }
              title="Approval required"
              description="Review this tool call before it can continue."
              actions={[
                {
                  label: "Approve",
                  variant: "secondary",
                  icon: <CheckCircleIcon className="size-4" />,
                  onClick: () =>
                    onToolApprovalResponse({
                      id: (part as { approval: { id: string } }).approval.id,
                      approved: true,
                    }),
                },
                {
                  label: "Decline",
                  variant: "outline",
                  onClick: () =>
                    onToolApprovalResponse({
                      id: (part as { approval: { id: string } }).approval.id,
                      approved: false,
                      reason: "User denied",
                    }),
                },
              ]}
            />
          )}
        {errorText ? <ToolErrorDetails errorText={errorText} /> : null}
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

const getHeaderState = ({
  state,
  toolResultPart,
  errorText,
}: {
  state: ToolUIPart["state"] | DynamicToolUIPart["state"];
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  errorText: string | undefined;
}) => {
  return getToolHeaderState({ state, toolResultPart, errorText });
};

type CompactGroup = {
  startIndex: number;
  entries: Array<{
    partIndex: number;
    toolName: string;
    // biome-ignore lint/suspicious/noExplicitAny: Tool parts have dynamic structure
    part: any;
    // biome-ignore lint/suspicious/noExplicitAny: Tool result parts have dynamic structure
    toolResultPart: any;
    // biome-ignore lint/suspicious/noExplicitAny: Error text extraction is dynamic
    errorText: any;
  }>;
};

/**
 * Pre-processes message parts to identify groups of consecutive compact-eligible tools.
 * Returns a map from the first part index of each group to the group data,
 * and a set of all part indices consumed by compact groups.
 *
 * Pass 1: Build a map from toolCallId → result part index, and identify invocation indices.
 * Pass 2: Walk invocations in order, skipping result-only parts and non-tool parts,
 *          grouping consecutive compact-eligible invocations together.
 */
function identifyCompactGroups(
  // biome-ignore lint/suspicious/noExplicitAny: Message parts have dynamic structure
  parts: any[] | undefined,
): { groupMap: Map<number, CompactGroup>; consumedIndices: Set<number> } {
  const groupMap = new Map<number, CompactGroup>();
  const consumedIndices = new Set<number>();

  if (!parts) return { groupMap, consumedIndices };

  // Pass 1: Identify which parts are "duplicate result" parts (a result that
  // immediately follows its invocation with the same toolCallId) vs primary
  // tool parts. A tool part is primary if it's the first occurrence of its
  // toolCallId. The second occurrence (the result) is a duplicate.
  const seenToolCallIds = new Set<string>();
  const duplicateResultIndices = new Set<number>();
  const invocationIndices: number[] = [];
  // Map from toolCallId to the index of the duplicate result part
  const resultByCallId = new Map<string, number>();

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!isToolPart(part)) continue;

    const callId = part.toolCallId;
    if (callId && seenToolCallIds.has(callId)) {
      // This is a duplicate result part
      duplicateResultIndices.add(i);
      resultByCallId.set(callId, i);
    } else {
      // Primary tool part (may have state "output-available" if combined)
      if (callId) seenToolCallIds.add(callId);
      invocationIndices.push(i);
    }
  }

  // Pass 2: Group consecutive compact-eligible invocations
  let currentGroup: CompactGroup | null = null;

  for (const idx of invocationIndices) {
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic tool parts have toolName property
    const rawPart = parts[idx] as any;

    const toolName: string | null =
      rawPart.type === "dynamic-tool"
        ? rawPart.toolName
        : rawPart.type?.startsWith("tool-")
          ? rawPart.type.replace("tool-", "")
          : null;

    if (!toolName) {
      if (currentGroup && currentGroup.entries.length > 0) {
        groupMap.set(currentGroup.startIndex, currentGroup);
        currentGroup = null;
      }
      continue;
    }

    // Find matching result part
    const resultIdx = rawPart.toolCallId
      ? resultByCallId.get(rawPart.toolCallId)
      : undefined;
    const toolResultPart = resultIdx !== undefined ? parts[resultIdx] : null;

    const errorText = getToolErrorText({ part: rawPart, toolResultPart });

    if (isCompactEligible({ part: rawPart, toolResultPart, toolName })) {
      if (!currentGroup) {
        currentGroup = { startIndex: idx, entries: [] };
      }
      currentGroup.entries.push({
        partIndex: idx,
        toolName,
        part: rawPart,
        toolResultPart,
        errorText,
      });
      consumedIndices.add(idx);
      if (resultIdx !== undefined) {
        consumedIndices.add(resultIdx);
      }
    } else {
      // Non-compact tool breaks the group
      if (currentGroup && currentGroup.entries.length > 0) {
        groupMap.set(currentGroup.startIndex, currentGroup);
        currentGroup = null;
      }
    }
  }

  // Finalize last group
  if (currentGroup && currentGroup.entries.length > 0) {
    groupMap.set(currentGroup.startIndex, currentGroup);
  }

  return { groupMap, consumedIndices };
}

/**
 * Renders a "Switched to {agent}" divider after all parts of a message
 * that contains a swap_agent tool call.
 */
function isSwapAgentPokeMessage(message: UIMessage): boolean {
  if (message.role !== "user") return false;
  const textParts = message.parts?.filter((p) => p.type === "text") ?? [];
  if (textParts.length !== 1) return false;
  const text = (textParts[0] as { text?: string }).text;
  if (typeof text !== "string") return false;
  return (
    text === SWAP_AGENT_POKE_TEXT ||
    text === SWAP_AGENT_FAILED_POKE_TEXT ||
    text === SWAP_TO_DEFAULT_AGENT_POKE_TEXT ||
    text.startsWith(SWAP_AGENT_POKE_PREFIX)
  );
}

const SWAP_TOOL_NAMES = new Set([
  TOOL_SWAP_AGENT_FULL_NAME,
  `tool-${TOOL_SWAP_AGENT_FULL_NAME}`,
  TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME,
  `tool-${TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME}`,
]);

function SwapAgentDivider({ message }: { message: UIMessage }) {
  if (message.role !== "assistant") return null;

  for (const part of message.parts ?? []) {
    if (!isToolPart(part)) continue;
    const type = part.type as string;
    if (!SWAP_TOOL_NAMES.has(type)) continue;

    // Don't show divider if the swap tool errored
    if (hasSwapToolError(part, message.parts ?? [])) return null;

    // Determine agent name for the divider
    let agentName = "another agent";
    const isSwapToDefault =
      type === TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME ||
      type === `tool-${TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME}`;

    if (isSwapToDefault) {
      agentName = "default agent";
    } else {
      // Try tool call input first (always available), then fall back to output
      const input = (part as Record<string, unknown>).input as
        | Record<string, unknown>
        | undefined;
      if (input?.agent_name && typeof input.agent_name === "string") {
        agentName = input.agent_name;
      } else {
        const output = part.output ?? part.state;
        if (typeof output === "string") {
          try {
            const parsed = JSON.parse(output);
            if (parsed?.agent_name) agentName = parsed.agent_name;
          } catch {
            // ignore
          }
        }
      }
    }

    return (
      <div className="flex items-center gap-3 py-2">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">
          Switched to {agentName}
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>
    );
  }

  return null;
}

// biome-ignore lint/suspicious/noExplicitAny: Tool parts have dynamic structure
function hasSwapToolError(part: any, allParts: any[]): boolean {
  // Check the part itself for errors
  if (getToolErrorText({ part, toolResultPart: null })) return true;

  // Check the paired result part (same toolCallId, different instance)
  if (part.toolCallId) {
    const resultPart = allParts.find(
      (p) => p !== part && isToolPart(p) && p.toolCallId === part.toolCallId,
    );
    if (resultPart) {
      if (getToolErrorText({ part: resultPart, toolResultPart: null })) {
        return true;
      }
    }
  }
  return false;
}
