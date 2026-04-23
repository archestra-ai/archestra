import type { UIMessage } from "@ai-sdk/react";
import {
  type ArchestraToolShortName,
  type archestraApiTypes,
  parseFullToolName,
  SWAP_AGENT_FAILED_POKE_TEXT,
  SWAP_AGENT_POKE_PREFIX,
  SWAP_AGENT_POKE_TEXT,
  SWAP_TO_DEFAULT_AGENT_POKE_TEXT,
  TOOL_SWAP_AGENT_FULL_NAME,
  TOOL_SWAP_AGENT_SHORT_NAME,
  TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME,
  TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME,
  TOOL_TODO_WRITE_FULL_NAME,
  TOOL_TODO_WRITE_SHORT_NAME,
} from "@shared";
import type { ChatStatus, DynamicToolUIPart, ToolUIPart } from "ai";
import { BotIcon, CheckCircleIcon, ClockIcon } from "lucide-react";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
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
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useProfileToolsWithIds } from "@/lib/chat/chat.query";
import { useUpdateChatMessage } from "@/lib/chat/chat-message.query";
import {
  getCompactToolState,
  getToolErrorText,
  getToolHeaderState,
  getToolNameFromPart,
} from "@/lib/chat/chat-tools-display.utils";
import { useGlobalChat } from "@/lib/chat/global-chat.context";
import {
  hasToolPartsWithAuthErrors,
  isAuthInstructionText,
  parsePolicyDenied,
  resolveAssistantTextAuthState,
  resolveToolAuthState,
} from "@/lib/chat/mcp-error-ui";
import { hasThinkingTags, parseThinkingTags } from "@/lib/chat/parse-thinking";
import { getSwapToolShortName } from "@/lib/chat/swap-agent.utils";
import type { ModelSource } from "@/lib/chat/use-chat-preferences";
import { useAppIconLogo } from "@/lib/hooks/use-app-name";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpInstallOrchestrator } from "@/lib/mcp/mcp-install-orchestrator.hook";
import { useOrganization } from "@/lib/organization.query";
import { cn } from "@/lib/utils";
import { AssignedCredentialUnavailableTool } from "./assigned-credential-unavailable-tool";
import { AuthRequiredTool } from "./auth-required-tool";
import {
  extractFileAttachments,
  filterOptimisticToolCalls,
  hasTextPart,
  identifyCompactToolGroups,
} from "./chat-messages.utils";
import { CompactToolGroup, type ToolIconMap } from "./compact-tool-call";
import { EditableAssistantMessage } from "./editable-assistant-message";
import { EditableUserMessage } from "./editable-user-message";
import { ExpiredAuthTool } from "./expired-auth-tool";
import { InlineChatError } from "./inline-chat-error";
import { hasKnowledgeBaseToolCall } from "./knowledge-graph-citations";
import { McpAppSection, type McpToolOutput } from "./mcp-app-container";
import { McpInstallDialogs } from "./mcp-install-dialogs";
import {
  findScrollContainer,
  PreexistingUnsafeContextDivider,
  SensitiveContextStickyIndicator,
  shouldShowStickyBoundaryIndicator,
  UnsafeContextStartsHereDivider,
} from "./message-boundary-divider";
import { PolicyDeniedTool } from "./policy-denied-tool";
import { SwapAgentBoundaryDivider } from "./swap-agent-boundary";
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
  chatErrors?: archestraApiTypes.GetChatConversationResponses["200"]["chatErrors"];
  /** Callback for tool approval responses (approve/deny) */
  onToolApprovalResponse?: (params: {
    id: string;
    approved: boolean;
    reason?: string;
  }) => void;
  agentName?: string;
  selectedModel?: string;
  modelSource?: ModelSource | null;
  unsafeContextBoundary?: archestraApiTypes.GetInteractionResponses["200"]["unsafeContextBoundary"];
}

type PersistedChatError =
  archestraApiTypes.GetChatConversationResponses["200"]["chatErrors"][number];

type TimelineItem =
  | { kind: "message"; message: UIMessage; messageIndex: number }
  | { kind: "chat-error"; chatError: PersistedChatError };

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
    (part.type?.startsWith("tool-") ||
      part.type?.startsWith("data-tool-ui-start") ||
      part.type === "dynamic-tool")
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
  chatErrors = [],
  onToolApprovalResponse,
  agentName,
  selectedModel,
  modelSource,
  unsafeContextBoundary,
}: ChatMessagesProps) {
  const isStreamingStalled = useStreamingStallDetection(messages, status);
  const { data: authSession } = useSession();
  const isDebugging = authSession?.user?.name?.endsWith("(debugging)") ?? false;

  // Track editing by messageId-partIndex to support multiple text parts per message
  const [editingPartKey, setEditingPartKey] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const { data: canExpandToolCalls } = useHasPermissions({
    chatExpandToolCalls: ["enable"],
  });
  const { data: canReadToolPolicy } = useHasPermissions({
    toolPolicy: ["read"],
  });
  const { data: canReadMcpRegistry } = useHasPermissions({
    mcpRegistry: ["read"],
  });
  const { data: organization } = useOrganization();
  const appIconLogo = useAppIconLogo();
  const { getToolName, getToolShortName } = useArchestraMcpIdentity();
  const orchestrator = useMcpInstallOrchestrator();
  const nonCompactToolNames = useMemo(
    () =>
      new Set([
        TOOL_SWAP_AGENT_FULL_NAME,
        TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME,
        TOOL_TODO_WRITE_FULL_NAME,
        getToolName(TOOL_SWAP_AGENT_SHORT_NAME),
        getToolName(TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME),
        getToolName(TOOL_TODO_WRITE_SHORT_NAME),
      ]),
    [getToolName],
  );

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

  const updateChatMessageMutation = useUpdateChatMessage(conversationId);

  // Get early UI data from the chat session
  const { getSession } = useGlobalChat();
  const session = conversationId ? getSession(conversationId) : null;
  const earlyToolUiStarts = session?.earlyToolUiStarts || {};

  // Debounce resize mode change when exiting edit mode to let DOM settle
  const isEditing = editingPartKey !== null;
  const [instantResize, setInstantResize] = useState(false);
  // Track initial message load to use instant resize (avoids visible scroll-to-bottom)
  const hasLoadedMessagesRef = useRef(false);
  const [initialLoad, setInitialLoad] = useState(true);
  useLayoutEffect(() => {
    if (messages.length > 0 && !hasLoadedMessagesRef.current) {
      hasLoadedMessagesRef.current = true;
      // Keep instant resize for the first render with messages, then switch to smooth
      const timeout = setTimeout(() => setInitialLoad(false), 100);
      return () => clearTimeout(timeout);
    }
  }, [messages.length]);
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
  const unsafeBoundaryRef = useRef<HTMLDivElement>(null);
  const [showStickyUnsafeIndicator, setShowStickyUnsafeIndicator] =
    useState(false);

  const isResponseInProgress = status === "streaming" || status === "submitted";
  const inferredUnsafeTextBoundary = useMemo(
    () =>
      inferUnsafeTextBoundary({
        messages,
        canReadToolPolicy: !!canReadToolPolicy,
        unsafeContextBoundary,
      }),
    [messages, canReadToolPolicy, unsafeContextBoundary],
  );

  useEffect(() => {
    const boundaryElement = unsafeBoundaryRef.current;
    if (!boundaryElement) {
      setShowStickyUnsafeIndicator(false);
      return;
    }

    const scrollContainer = findScrollContainer(boundaryElement);
    if (!scrollContainer) {
      setShowStickyUnsafeIndicator(false);
      return;
    }

    const updateStickyState = () => {
      const boundaryRect = boundaryElement.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();
      setShowStickyUnsafeIndicator(
        shouldShowStickyBoundaryIndicator({
          boundaryTop: boundaryRect.top,
          boundaryBottom: boundaryRect.bottom,
          containerTop: containerRect.top,
        }),
      );
    };

    updateStickyState();
    scrollContainer.addEventListener("scroll", updateStickyState, {
      passive: true,
    });
    window.addEventListener("resize", updateStickyState);

    return () => {
      scrollContainer.removeEventListener("scroll", updateStickyState);
      window.removeEventListener("resize", updateStickyState);
    };
  });

  const assistantMessageCount = useMemo(
    () => messages.filter((m) => m.role === "assistant").length,
    [messages],
  );

  if (messages.length === 0 && chatErrors.length === 0) {
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
  const timelineItems = buildMessageTimeline({ messages, chatErrors });
  const liveErrorMessage = error ? getInlineErrorMessage(error) : null;
  const hasRenderedLiveError =
    !!error &&
    chatErrors.some(
      (chatError) => chatError.error.message === liveErrorMessage,
    );

  return (
    <Conversation
      className="h-full"
      resize={instantResize || initialLoad ? "instant" : "smooth"}
    >
      <ScrollToBottomOnSubmit status={status} />
      <ConversationContent>
        <div className="max-w-4xl mx-auto relative pb-8">
          <SensitiveContextStickyIndicator
            visible={showStickyUnsafeIndicator}
          />
          {unsafeContextBoundary?.kind === "preexisting_untrusted" && (
            <PreexistingUnsafeContextDivider dividerRef={unsafeBoundaryRef} />
          )}
          {timelineItems.map((item) => {
            if (item.kind === "chat-error") {
              return (
                <InlineChatError
                  key={`chat-error-${item.chatError.id}`}
                  error={new Error(JSON.stringify(item.chatError.error))}
                  conversationId={conversationId}
                  supportMessage={organization?.chatErrorSupportMessage}
                  slimChatErrorUi={organization?.slimChatErrorUi ?? false}
                  agentName={agentName}
                  selectedModel={selectedModel}
                  modelSource={modelSource}
                />
              );
            }

            const { message, messageIndex: idx } = item;
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
                  const { groupMap, consumedIndices } =
                    identifyCompactToolGroups(message.parts, {
                      nonCompactToolNames,
                      getToolShortName,
                      mcpAppToolCallIds: new Set(
                        Object.keys(earlyToolUiStarts),
                      ),
                    });
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
                      return renderCompactGroupWithUnsafeContextDivider({
                        partKey: getCompactGroupKey(
                          message.id,
                          group.startIndex,
                        ),
                        parts: group.entries.map(
                          (entry) => entry.toolResultPart ?? entry.part,
                        ),
                        dividerRef: unsafeBoundaryRef,
                        unsafeContextBoundary,
                        canReadToolPolicy: !!canReadToolPolicy,
                        renderedPart: (
                          <CompactToolGroup
                            key={getCompactGroupKey(
                              message.id,
                              group.startIndex,
                            )}
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
                        ),
                      });
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
                        const assistantAuthState =
                          resolveAssistantTextAuthState(part.text);
                        const textToolAuthState = resolveToolAuthState({
                          errorText: part.text,
                        });
                        if (textToolAuthState?.kind === "policy-denied") {
                          const shouldRenderPolicyDeniedUnsafeBoundary =
                            !!canReadToolPolicy &&
                            textToolAuthState.policyDenied
                              .unsafeContextActiveAtRequestStart &&
                            !hasUnsafeBoundaryBefore({
                              messages,
                              beforeMessageIndex: idx,
                              beforePartIndex: i,
                              unsafeContextBoundary,
                              inferredUnsafeTextBoundary,
                            });
                          return (
                            <Fragment key={partKey}>
                              {shouldRenderPolicyDeniedUnsafeBoundary && (
                                <PreexistingUnsafeContextDivider
                                  dividerRef={unsafeBoundaryRef}
                                />
                              )}
                              <PolicyDeniedTool
                                policyDenied={textToolAuthState.policyDenied}
                                {...(agentId
                                  ? { editable: true, profileId: agentId }
                                  : { editable: false })}
                              />
                            </Fragment>
                          );
                        }

                        // Use editable component for assistant messages
                        if (message.role === "assistant") {
                          const shouldRenderInferredUnsafeBoundary =
                            inferredUnsafeTextBoundary?.messageId ===
                              message.id &&
                            inferredUnsafeTextBoundary.partIndex === i;
                          if (
                            hasMessageAuthToolError(message) &&
                            isAuthInstructionText(part.text)
                          ) {
                            return null;
                          }

                          const authToolPart = renderAssistantAuthPart({
                            toolName: "authentication",
                            authState: assistantAuthState,
                            onInstallMcp:
                              orchestrator.triggerInstallByCatalogId,
                            onReauthMcp:
                              orchestrator.triggerReauthByCatalogIdAndServerId,
                          });
                          if (authToolPart) {
                            if (hasMessageAuthToolError(message)) {
                              return null;
                            }
                            return (
                              <Fragment key={partKey}>{authToolPart}</Fragment>
                            );
                          }

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
                              {shouldRenderInferredUnsafeBoundary && (
                                <UnsafeContextStartsHereDivider
                                  dividerRef={unsafeBoundaryRef}
                                />
                              )}
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

                        return renderPartWithUnsafeContextDivider({
                          partKey,
                          part: toolResultPart ?? part,
                          dividerRef: unsafeBoundaryRef,
                          unsafeContextBoundary,
                          canReadToolPolicy: !!canReadToolPolicy,
                          renderedPart: (
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
                              getToolShortName={getToolShortName}
                              toolIconMap={toolIconMap}
                              earlyToolUiData={
                                part.toolCallId
                                  ? earlyToolUiStarts[part.toolCallId]
                                  : undefined
                              }
                              onSendMessage={(text) =>
                                session?.sendMessage({
                                  role: "user",
                                  parts: [{ type: "text", text }],
                                  metadata: {
                                    createdAt: new Date().toISOString(),
                                  },
                                })
                              }
                            />
                          ),
                        });
                      }

                      default: {
                        // data-tool-ui-start: early MCP App initialisation.
                        // This is the canonical render for the tool UI. It looks ahead
                        // in the parts array to find the matching input/output parts so
                        // a single <MessageTool> covers the full lifecycle.
                        if (part.type?.startsWith("data-tool-ui-start")) {
                          // biome-ignore lint/suspicious/noExplicitAny: data-tool-ui-start shape is dynamic
                          const earlyPart = part as any;
                          const tcId = earlyPart.data?.toolCallId as
                            | string
                            | undefined;
                          const toolName = earlyPart.data?.toolName as
                            | string
                            | undefined;
                          if (!tcId || !toolName) return null;

                          // Find the matching tool-* parts (may or may not exist yet)
                          // biome-ignore lint/suspicious/noExplicitAny: part shape varies
                          const allParts = (message.parts ?? []) as any[];
                          const inputPart = allParts.find(
                            (p) =>
                              isToolPart(p) &&
                              p.toolCallId === tcId &&
                              p.state !== "output-available",
                          ) as ToolUIPart | undefined;

                          const outputPart = (allParts.find(
                            (p) =>
                              isToolPart(p) &&
                              p.toolCallId === tcId &&
                              p.state === "output-available",
                          ) ?? null) as ToolUIPart | null;

                          // Synthetic part used until the real tool-* part appears.
                          // If only outputPart exists (tool already done), borrow its input.
                          const effectivePart = (inputPart ?? {
                            type: `tool-${toolName}` as `tool-${string}`,
                            toolCallId: tcId,
                            state: outputPart
                              ? ("output-available" as const)
                              : ("input-streaming" as const),
                            input: outputPart?.input ?? {},
                            output: outputPart?.output,
                          }) as ToolUIPart;

                          return renderPartWithUnsafeContextDivider({
                            partKey,
                            part: outputPart ?? effectivePart,
                            dividerRef: unsafeBoundaryRef,
                            unsafeContextBoundary,
                            canReadToolPolicy: !!canReadToolPolicy,
                            renderedPart: (
                              <MessageTool
                                key={`${message.id}-${tcId}`}
                                part={effectivePart}
                                toolResultPart={outputPart}
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
                                getToolShortName={getToolShortName}
                                toolIconMap={toolIconMap}
                                onSendMessage={(text) =>
                                  session?.sendMessage({
                                    role: "user",
                                    parts: [{ type: "text", text }],
                                    metadata: {
                                      createdAt: new Date().toISOString(),
                                    },
                                  })
                                }
                                earlyToolUiData={earlyToolUiStarts[tcId]}
                              />
                            ),
                          });
                        }

                        // Regular tool-* parts: skip if a data-tool-ui-start already
                        // rendered this toolCallId (it owns the full lifecycle above).
                        if (
                          isToolPart(part) &&
                          part.type?.startsWith("tool-")
                        ) {
                          const tcId = part.toolCallId;
                          const hasEarlyStart =
                            tcId &&
                            (message.parts ?? []).some(
                              (p) =>
                                p.type?.startsWith("data-tool-ui-start") &&
                                (p as { data?: { toolCallId?: string } }).data
                                  ?.toolCallId === tcId,
                            );
                          if (hasEarlyStart) return null;

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

                          return renderPartWithUnsafeContextDivider({
                            partKey,
                            part: toolResultPart ?? part,
                            dividerRef: unsafeBoundaryRef,
                            unsafeContextBoundary,
                            canReadToolPolicy: !!canReadToolPolicy,
                            renderedPart: (
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
                                getToolShortName={getToolShortName}
                                toolIconMap={toolIconMap}
                                earlyToolUiData={
                                  tcId ? earlyToolUiStarts[tcId] : undefined
                                }
                                onSendMessage={(text) =>
                                  session?.sendMessage({
                                    role: "user",
                                    parts: [{ type: "text", text }],
                                    metadata: {
                                      createdAt: new Date().toISOString(),
                                    },
                                  })
                                }
                              />
                            ),
                          });
                        }

                        // Skip step-start and other non-renderable parts
                        return null;
                      }
                    }
                  });
                })()}
                {message.role === "assistant" && (
                  <SwapAgentBoundaryDivider
                    parts={message.parts ?? []}
                    getToolShortName={getToolShortName}
                    hasToolError={hasSwapToolError}
                  />
                )}
              </div>
            );
          })}
          {/* Inline error display */}
          {error && !hasRenderedLiveError && (
            <InlineChatError
              error={error}
              conversationId={conversationId}
              supportMessage={organization?.chatErrorSupportMessage}
              slimChatErrorUi={organization?.slimChatErrorUi ?? false}
              agentName={agentName}
              selectedModel={selectedModel}
              modelSource={modelSource}
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
              getToolShortName={getToolShortName}
              toolIconMap={toolIconMap}
            />
          ))}
          {(status === "submitted" ||
            (status === "streaming" && isStreamingStalled)) && (
            <div className="absolute bottom-[-10] left-0">
              <Message from="assistant">
                <img
                  src={appIconLogo}
                  alt="Loading logo"
                  className="object-contain h-6 w-auto animate-[bounce_700ms_ease_200ms_infinite]"
                />
              </Message>
            </div>
          )}
        </div>
      </ConversationContent>
      <ChatScrollButton assistantMessageCount={assistantMessageCount} />
      <McpInstallDialogs orchestrator={orchestrator} />
    </Conversation>
  );
}

function getCompactGroupKey(messageId: string, startIndex: number): string {
  return `${messageId}-compact-${startIndex}`;
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

// Re-engage stick-to-bottom when the user sends a new message.
// If the user has scrolled up, the library keeps state.isAtBottom=false and
// won't auto-scroll on content resize — this resets it on the submit transition.
function ScrollToBottomOnSubmit({ status }: { status: ChatStatus }) {
  const { scrollToBottom } = useStickToBottomContext();
  const prevStatusRef = useRef(status);

  useEffect(() => {
    if (status === "submitted" && prevStatusRef.current !== "submitted") {
      scrollToBottom();
    }

    prevStatusRef.current = status;
  }, [status, scrollToBottom]);

  return null;
}

// Scroll-to-bottom FAB with a "New messages" label when a new assistant
// message has arrived while the user is scrolled up.
function ChatScrollButton({
  assistantMessageCount,
}: {
  assistantMessageCount: number;
}) {
  const { isAtBottom } = useStickToBottomContext();
  const lastSeenCountRef = useRef(assistantMessageCount);

  useEffect(() => {
    if (isAtBottom) {
      lastSeenCountRef.current = assistantMessageCount;
    }
  }, [isAtBottom, assistantMessageCount]);

  const hasNewMessages =
    !isAtBottom && assistantMessageCount > lastSeenCountRef.current;

  return (
    <ConversationScrollButton
      label={hasNewMessages ? "New messages" : undefined}
    />
  );
}

const MessageTool = memo(
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
    getToolShortName,
    onSendMessage,
    earlyToolUiData,
    toolIconMap,
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
    getToolShortName: (toolName: string) => ArchestraToolShortName | null;
    onSendMessage?: (text: string) => void;
    toolIconMap?: ToolIconMap;
    earlyToolUiData?: {
      uiResourceUri: string;
      html?: string;
      csp?: { connectDomains?: string[]; resourceDomains?: string[] };
      permissions?: {
        camera?: boolean;
        microphone?: boolean;
        geolocation?: boolean;
        clipboardWrite?: boolean;
      };
    };
  }) {
    const rawOutput = toolResultPart ? toolResultPart.output : part.output;
    const mcpOutput = rawOutput as McpToolOutput | undefined;
    const uiResourceUri =
      (mcpOutput?._meta?.ui as { resourceUri?: string } | undefined)
        ?.resourceUri ?? earlyToolUiData?.uiResourceUri;

    // Use the text content string when available; fall back to the raw output for non-MCP tools.
    const output = mcpOutput?.content ?? rawOutput;
    const errorText = getToolErrorText({ part, toolResultPart });

    const isApprovalRequested = part.state === "approval-requested";
    const isToolDenied = part.state === "output-denied";
    const hasInput = part.input && Object.keys(part.input).length > 0;
    const hasContent = Boolean(
      hasInput ||
        errorText ||
        isApprovalRequested ||
        (toolResultPart && Boolean(toolResultPart.output)) ||
        (!toolResultPart && Boolean(part.output)),
    );
    const shouldDefaultOpen = isApprovalRequested;

    // Hooks must be called before any early returns
    const [isOpen, setIsOpen] = useState(shouldDefaultOpen);
    const [userDenied, setUserDenied] = useState(false);
    const [userHasInteracted, setUserHasInteracted] = useState(false);
    const prevShouldDefaultOpenRef = useRef(shouldDefaultOpen);

    useEffect(() => {
      const prev = prevShouldDefaultOpenRef.current;
      if (!userHasInteracted) {
        setIsOpen(shouldDefaultOpen);
      } else if (shouldDefaultOpen && !prev) {
        // shouldDefaultOpen changed from false to true -> auto-open
        setIsOpen(true);
      }
      prevShouldDefaultOpenRef.current = shouldDefaultOpen;
    }, [shouldDefaultOpen, userHasInteracted]);
    const handleOpenChange = useCallback(
      (open: boolean) => {
        setIsOpen(open);
        if (open !== shouldDefaultOpen) {
          setUserHasInteracted(true);
        }
      },
      [shouldDefaultOpen],
    );

    const toolAuthState = resolveToolAuthState({
      errorText,
      rawOutput,
    });

    if (toolAuthState?.kind === "policy-denied") {
      return (
        <PolicyDeniedTool
          policyDenied={toolAuthState.policyDenied}
          {...(agentId
            ? { editable: true, profileId: agentId }
            : { editable: false })}
        />
      );
    }

    const authToolBody = renderToolAuthPart({
      toolName,
      authState: toolAuthState,
      onInstallMcp,
      onReauthMcp,
    });

    // swap_agent / swap_to_default_agent are rendered as dividers after all message parts (see SwapAgentDivider below)
    // Show the raw tool call when the user's name ends with "(debugging)"
    const swapToolShortName = getSwapToolShortName({
      toolName,
      getToolShortName,
    });
    if (
      !isDebugging &&
      (swapToolShortName === TOOL_SWAP_AGENT_SHORT_NAME ||
        swapToolShortName === TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME)
    ) {
      return null;
    }

    if (getToolShortName(toolName) === TOOL_TODO_WRITE_SHORT_NAME) {
      return (
        <TodoWriteTool
          part={part}
          toolResultPart={toolResultPart}
          errorText={errorText}
          onToolApprovalResponse={onToolApprovalResponse}
        />
      );
    }

    if (authToolBody) {
      const shortName = parseFullToolName(toolName).toolName.replace(/_/g, " ");
      const iconInfo = toolIconMap?.get(toolName);

      return (
        <div className="mb-1">
          <div className="flex items-center gap-1.5">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="relative inline-flex size-8 items-center justify-center rounded-full border bg-background">
                    {iconInfo?.icon || iconInfo?.catalogId ? (
                      <McpCatalogIcon
                        icon={iconInfo.icon}
                        catalogId={iconInfo.catalogId}
                        size={16}
                      />
                    ) : (
                      <BotIcon className="size-3.5 text-muted-foreground" />
                    )}
                    <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background bg-destructive" />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {shortName} (error)
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          {authToolBody}
        </div>
      );
    }

    // Show logs button for failed tool calls
    const logsButton = errorText ? (
      <ToolErrorLogsButton toolName={toolName} />
    ) : null;

    // MCP App tools: compact circle + canvas below (no collapsible wrapper)
    if (uiResourceUri && !isApprovalRequested && !errorText) {
      const compactState = getCompactToolState({ part, toolResultPart });
      const shortName = parseFullToolName(toolName).toolName.replace(/_/g, " ");
      const iconInfo = toolIconMap?.get(toolName);

      return (
        <div className="mb-1">
          <div className="flex items-center gap-1.5">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => handleOpenChange(!isOpen)}
                    className={cn(
                      "relative inline-flex items-center justify-center size-8 rounded-full border transition-all hover:bg-accent hover:border-accent-foreground/20",
                      isOpen &&
                        "bg-accent border-accent-foreground/20 ring-2 ring-primary/20",
                      !isOpen && "bg-background",
                    )}
                  >
                    {iconInfo?.icon || iconInfo?.catalogId ? (
                      <McpCatalogIcon
                        icon={iconInfo.icon}
                        catalogId={iconInfo.catalogId}
                        size={16}
                      />
                    ) : (
                      <BotIcon className="size-3.5 text-muted-foreground" />
                    )}
                    <span
                      className={cn(
                        "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background",
                        compactState === "completed" && "bg-green-500",
                        compactState === "running" &&
                          "bg-blue-500 animate-pulse",
                        compactState === "error" && "bg-destructive",
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {shortName}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          {isOpen && (
            <div className="mt-2">
              <Tool defaultOpen={true}>
                <ToolHeader
                  type={`tool-${toolName}`}
                  state={getHeaderState({
                    state: part.state || "input-available",
                    toolResultPart,
                    errorText,
                  })}
                  isCollapsible={!!hasInput}
                />
                <ToolContent>
                  {hasInput ? <ToolInput input={part.input} /> : null}
                  {toolResultPart && (
                    <ToolOutput
                      label="Result"
                      output={mcpOutput?.content ?? toolResultPart.output}
                    />
                  )}
                </ToolContent>
              </Tool>
            </div>
          )}
          {agentId && (
            <div className="mt-3">
              <McpAppSection
                uiResourceUri={uiResourceUri}
                agentId={agentId}
                toolName={toolName}
                toolInput={part.input as Record<string, unknown>}
                rawOutput={mcpOutput}
                preloadedResource={
                  earlyToolUiData?.html
                    ? {
                        html: earlyToolUiData.html,
                        csp: earlyToolUiData.csp,
                        permissions: earlyToolUiData.permissions,
                      }
                    : undefined
                }
                onSendMessage={onSendMessage}
              />
            </div>
          )}
        </div>
      );
    }

    const isExpandable =
      hasContent && (canExpandToolCalls || isApprovalRequested);

    return (
      <Tool
        className={isExpandable ? "cursor-pointer" : ""}
        open={isOpen}
        onOpenChange={handleOpenChange}
        defaultOpen={shouldDefaultOpen}
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
        <ToolContent forceMount={uiResourceUri ? true : undefined}>
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
                    onClick: () => {
                      setUserDenied(true);
                      onToolApprovalResponse({
                        id: (part as { approval: { id: string } }).approval.id,
                        approved: false,
                        reason: "User denied",
                      });
                    },
                  },
                ]}
              />
            )}
          {errorText && !authToolBody ? (
            <ToolErrorDetails errorText={errorText} />
          ) : null}
          {authToolBody}

          {/* Standard MCP Apps flow: tool definition has _meta.ui.resourceUri → AppBridge + AppFrame */}
          {!isApprovalRequested &&
            !isToolDenied &&
            !userDenied &&
            !errorText &&
            uiResourceUri &&
            agentId && (
              <McpAppSection
                uiResourceUri={uiResourceUri}
                agentId={agentId}
                toolName={toolName}
                toolInput={part.input as Record<string, unknown>}
                rawOutput={mcpOutput}
                preloadedResource={
                  earlyToolUiData?.html
                    ? {
                        html: earlyToolUiData.html,
                        csp: earlyToolUiData.csp,
                        permissions: earlyToolUiData.permissions,
                      }
                    : undefined
                }
                onSendMessage={onSendMessage}
              />
            )}
          {/* Show error output even when UI resource is present - errors take priority */}
          {!authToolBody && errorText && uiResourceUri && toolResultPart && (
            <ToolOutput label="Error" output={output} errorText={errorText} />
          )}
          {/* Show text output when NOT rendering a UI resource */}
          {!authToolBody && !uiResourceUri && toolResultPart && (
            <ToolOutput
              label={errorText ? "Error" : "Result"}
              output={output}
              errorText={errorText}
            />
          )}
          {!authToolBody &&
            !uiResourceUri &&
            !toolResultPart &&
            Boolean(part.output) && (
              <ToolOutput
                label={errorText ? "Error" : "Result"}
                output={output}
                errorText={errorText}
              />
            )}
        </ToolContent>
      </Tool>
    );
  },
  (prev, next) =>
    // Skip re-render unless identity, state, or UI-relevant data actually changed.
    // AI SDK recreates part/toolResultPart objects every streaming tick — compare
    // by value, not reference. During input-streaming, also re-render on input growth.
    prev.toolName === next.toolName &&
    prev.agentId === next.agentId &&
    prev.part.toolCallId === next.part.toolCallId &&
    prev.part.state === next.part.state &&
    (prev.part.state !== "input-streaming" ||
      prev.part.input === next.part.input) &&
    prev.toolResultPart?.state === next.toolResultPart?.state &&
    prev.earlyToolUiData?.uiResourceUri ===
      next.earlyToolUiData?.uiResourceUri &&
    !!prev.earlyToolUiData?.html === !!next.earlyToolUiData?.html &&
    prev.toolIconMap === next.toolIconMap,
);

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

function renderPartWithUnsafeContextDivider({
  partKey,
  part,
  renderedPart,
  dividerRef,
  unsafeContextBoundary,
  canReadToolPolicy,
}: {
  partKey: string;
  part: DynamicToolUIPart | ToolUIPart;
  renderedPart: React.ReactNode;
  dividerRef: React.Ref<HTMLDivElement>;
  unsafeContextBoundary?: archestraApiTypes.GetInteractionResponses["200"]["unsafeContextBoundary"];
  canReadToolPolicy: boolean;
}) {
  if (!canReadToolPolicy) {
    return renderedPart;
  }

  const resolvedUnsafeContextBoundary =
    extractUnsafeContextBoundaryFromToolOutput(part.output) ??
    unsafeContextBoundary;

  if (
    !resolvedUnsafeContextBoundary ||
    resolvedUnsafeContextBoundary.kind !== "tool_result"
  ) {
    return renderedPart;
  }

  if (
    !toolPartMatchesUnsafeContextBoundary(part, resolvedUnsafeContextBoundary)
  ) {
    return renderedPart;
  }

  return (
    <Fragment key={`${partKey}-unsafe-context-boundary`}>
      {renderedPart}
      <UnsafeContextStartsHereDivider dividerRef={dividerRef} />
    </Fragment>
  );
}

function renderCompactGroupWithUnsafeContextDivider({
  partKey,
  parts,
  renderedPart,
  dividerRef,
  unsafeContextBoundary,
  canReadToolPolicy,
}: {
  partKey: string;
  parts: Array<DynamicToolUIPart | ToolUIPart>;
  renderedPart: React.ReactNode;
  dividerRef: React.Ref<HTMLDivElement>;
  unsafeContextBoundary?: archestraApiTypes.GetInteractionResponses["200"]["unsafeContextBoundary"];
  canReadToolPolicy: boolean;
}) {
  if (!canReadToolPolicy) {
    return renderedPart;
  }

  const resolvedUnsafeContextBoundary =
    parts
      .map((part) => extractUnsafeContextBoundaryFromToolOutput(part.output))
      .find((boundary) => boundary?.kind === "tool_result") ??
    unsafeContextBoundary;

  if (
    !resolvedUnsafeContextBoundary ||
    resolvedUnsafeContextBoundary.kind !== "tool_result"
  ) {
    return renderedPart;
  }

  if (
    !parts.some((part) =>
      toolPartMatchesUnsafeContextBoundary(part, resolvedUnsafeContextBoundary),
    )
  ) {
    return renderedPart;
  }

  return (
    <Fragment key={`${partKey}-unsafe-context-boundary`}>
      {renderedPart}
      <UnsafeContextStartsHereDivider dividerRef={dividerRef} />
    </Fragment>
  );
}

function extractUnsafeContextBoundaryFromToolOutput(
  output: unknown,
): archestraApiTypes.GetInteractionResponses["200"]["unsafeContextBoundary"] {
  if (
    typeof output === "object" &&
    output !== null &&
    "unsafeContextBoundary" in output
  ) {
    const topLevelUnsafeContextBoundary = output.unsafeContextBoundary;
    if (
      typeof topLevelUnsafeContextBoundary === "object" &&
      topLevelUnsafeContextBoundary !== null &&
      "kind" in topLevelUnsafeContextBoundary &&
      topLevelUnsafeContextBoundary.kind === "tool_result" &&
      "toolCallId" in topLevelUnsafeContextBoundary &&
      typeof topLevelUnsafeContextBoundary.toolCallId === "string" &&
      "toolName" in topLevelUnsafeContextBoundary &&
      typeof topLevelUnsafeContextBoundary.toolName === "string" &&
      "reason" in topLevelUnsafeContextBoundary &&
      isUnsafeContextBoundaryReason(topLevelUnsafeContextBoundary.reason)
    ) {
      return {
        kind: "tool_result",
        reason: topLevelUnsafeContextBoundary.reason,
        toolCallId: topLevelUnsafeContextBoundary.toolCallId,
        toolName: topLevelUnsafeContextBoundary.toolName,
      };
    }
  }

  if (
    typeof output !== "object" ||
    output === null ||
    !("_meta" in output) ||
    typeof output._meta !== "object" ||
    output._meta === null ||
    !("unsafeContextBoundary" in output._meta)
  ) {
    return undefined;
  }

  const unsafeContextBoundary = output._meta.unsafeContextBoundary;
  if (
    typeof unsafeContextBoundary !== "object" ||
    unsafeContextBoundary === null ||
    !("kind" in unsafeContextBoundary) ||
    unsafeContextBoundary.kind !== "tool_result" ||
    !("toolCallId" in unsafeContextBoundary) ||
    typeof unsafeContextBoundary.toolCallId !== "string" ||
    !("toolName" in unsafeContextBoundary) ||
    typeof unsafeContextBoundary.toolName !== "string" ||
    !("reason" in unsafeContextBoundary) ||
    !isUnsafeContextBoundaryReason(unsafeContextBoundary.reason)
  ) {
    return undefined;
  }

  return {
    kind: "tool_result",
    reason: unsafeContextBoundary.reason,
    toolCallId: unsafeContextBoundary.toolCallId,
    toolName: unsafeContextBoundary.toolName,
  };
}

type UnsafeContextBoundaryReason = NonNullable<
  archestraApiTypes.GetInteractionResponses["200"]["unsafeContextBoundary"]
>["reason"];

const unsafeContextBoundaryReasonMap = {
  agent_configured_untrusted: true,
  inherited_from_parent: true,
  tool_result_marked_untrusted: true,
  tool_result_blocked: true,
} as const satisfies Record<UnsafeContextBoundaryReason, true>;

function isUnsafeContextBoundaryReason(
  reason: unknown,
): reason is UnsafeContextBoundaryReason {
  return typeof reason === "string" && reason in unsafeContextBoundaryReasonMap;
}

function toolPartMatchesUnsafeContextBoundary(
  part: DynamicToolUIPart | ToolUIPart,
  boundary: Extract<
    NonNullable<
      archestraApiTypes.GetInteractionResponses["200"]["unsafeContextBoundary"]
    >,
    { kind: "tool_result" }
  >,
): boolean {
  if (part.toolCallId === boundary.toolCallId) {
    return true;
  }

  const partToolName = getToolNameFromPart(part);
  return partToolName === boundary.toolName;
}

function inferUnsafeTextBoundary(params: {
  messages: UIMessage[];
  canReadToolPolicy: boolean;
  unsafeContextBoundary?: archestraApiTypes.GetInteractionResponses["200"]["unsafeContextBoundary"];
}): { messageId: string; partIndex: number } | undefined {
  if (!params.canReadToolPolicy) {
    return undefined;
  }

  if (params.unsafeContextBoundary?.kind === "tool_result") {
    return undefined;
  }

  const hasExplicitToolBoundary = params.messages.some((message) =>
    (message.parts ?? []).some(
      (part) =>
        isToolPart(part) &&
        extractUnsafeContextBoundaryFromToolOutput(part.output)?.kind ===
          "tool_result",
    ),
  );
  if (hasExplicitToolBoundary) {
    return undefined;
  }

  const firstSensitiveDenialIndex = params.messages.findIndex((message) =>
    (message.parts ?? []).some(
      (part) =>
        part.type === "text" &&
        parsePolicyDenied(part.text)?.unsafeContextActiveAtRequestStart,
    ),
  );
  if (firstSensitiveDenialIndex <= 0) {
    return undefined;
  }

  for (
    let messageIndex = 0;
    messageIndex < firstSensitiveDenialIndex;
    messageIndex++
  ) {
    const message = params.messages[messageIndex];
    if (message.role !== "assistant" || !message.id) {
      continue;
    }

    let sawToolOutput = false;
    for (
      let partIndex = 0;
      partIndex < (message.parts?.length ?? 0);
      partIndex++
    ) {
      const part = message.parts[partIndex];
      if (isToolPart(part) && part.state === "output-available") {
        sawToolOutput = true;
        continue;
      }

      if (
        sawToolOutput &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.trim().length > 0
      ) {
        return {
          messageId: message.id,
          partIndex,
        };
      }
    }
  }

  return undefined;
}

function hasUnsafeBoundaryBefore(params: {
  messages: UIMessage[];
  beforeMessageIndex: number;
  beforePartIndex: number;
  unsafeContextBoundary?: archestraApiTypes.GetInteractionResponses["200"]["unsafeContextBoundary"];
  inferredUnsafeTextBoundary?: { messageId: string; partIndex: number };
}): boolean {
  if (params.unsafeContextBoundary?.kind === "preexisting_untrusted") {
    return true;
  }

  if (
    params.inferredUnsafeTextBoundary &&
    isMessagePositionBefore({
      messages: params.messages,
      boundaryMessageId: params.inferredUnsafeTextBoundary.messageId,
      boundaryPartIndex: params.inferredUnsafeTextBoundary.partIndex,
      beforeMessageIndex: params.beforeMessageIndex,
      beforePartIndex: params.beforePartIndex,
    })
  ) {
    return true;
  }

  for (
    let messageIndex = 0;
    messageIndex <= params.beforeMessageIndex;
    messageIndex++
  ) {
    const message = params.messages[messageIndex];
    const lastPartIndex =
      messageIndex === params.beforeMessageIndex
        ? params.beforePartIndex - 1
        : (message.parts?.length ?? 0) - 1;

    for (let partIndex = 0; partIndex <= lastPartIndex; partIndex++) {
      const part = message.parts?.[partIndex];
      if (!part) {
        continue;
      }

      if (
        part.type === "text" &&
        parsePolicyDenied(part.text)?.unsafeContextActiveAtRequestStart
      ) {
        return true;
      }

      if (
        isToolPart(part) &&
        part.state === "output-available" &&
        matchesThreadUnsafeBoundary({
          part,
          unsafeContextBoundary: params.unsafeContextBoundary,
        })
      ) {
        return true;
      }
    }
  }

  return false;
}

function matchesThreadUnsafeBoundary(params: {
  part: DynamicToolUIPart | ToolUIPart;
  unsafeContextBoundary?: archestraApiTypes.GetInteractionResponses["200"]["unsafeContextBoundary"];
}): boolean {
  const boundaryFromOutput = extractUnsafeContextBoundaryFromToolOutput(
    params.part.output,
  );
  if (boundaryFromOutput?.kind === "tool_result") {
    return true;
  }

  if (params.unsafeContextBoundary?.kind !== "tool_result") {
    return false;
  }

  return toolPartMatchesUnsafeContextBoundary(
    params.part,
    params.unsafeContextBoundary,
  );
}

function isMessagePositionBefore(params: {
  messages: UIMessage[];
  boundaryMessageId: string;
  boundaryPartIndex: number;
  beforeMessageIndex: number;
  beforePartIndex: number;
}): boolean {
  const boundaryMessageIndex = params.messages.findIndex(
    (message) => message.id === params.boundaryMessageId,
  );

  if (boundaryMessageIndex === -1) {
    return false;
  }

  if (boundaryMessageIndex < params.beforeMessageIndex) {
    return true;
  }

  if (boundaryMessageIndex > params.beforeMessageIndex) {
    return false;
  }

  return params.boundaryPartIndex < params.beforePartIndex;
}

function renderToolAuthPart(params: {
  toolName: string;
  authState: ReturnType<typeof resolveToolAuthState>;
  onInstallMcp?: (catalogId: string) => void;
  onReauthMcp?: (catalogId: string, serverId: string) => void;
}) {
  const { authState, toolName, onInstallMcp, onReauthMcp } = params;

  if (authState?.kind === "auth-expired") {
    const { catalogId, serverId } = authState;
    return (
      <ExpiredAuthTool
        toolName={toolName}
        catalogName={authState.catalogName}
        reauthUrl={authState.reauthUrl}
        onReauth={
          onReauthMcp && catalogId && serverId
            ? () => onReauthMcp(catalogId, serverId)
            : undefined
        }
      />
    );
  }

  if (authState?.kind === "assigned-credential-unavailable") {
    return (
      <AssignedCredentialUnavailableTool catalogName={authState.catalogName} />
    );
  }

  if (authState?.kind === "auth-required") {
    const { catalogId } = authState;
    return (
      <AuthRequiredTool
        toolName={toolName}
        catalogName={authState.catalogName}
        installUrl={authState.installUrl}
        onInstall={
          onInstallMcp && catalogId ? () => onInstallMcp(catalogId) : undefined
        }
      />
    );
  }

  return null;
}

function renderAssistantAuthPart(params: {
  toolName: string;
  authState: ReturnType<typeof resolveAssistantTextAuthState>;
  onInstallMcp?: (catalogId: string) => void;
  onReauthMcp?: (catalogId: string, serverId: string) => void;
}) {
  const { authState, toolName, onInstallMcp, onReauthMcp } = params;

  if (authState?.kind === "auth-expired") {
    const { catalogId, serverId } = authState;
    return (
      <ExpiredAuthTool
        toolName={toolName}
        catalogName={authState.catalogName}
        reauthUrl={authState.reauthUrl}
        onReauth={
          onReauthMcp && catalogId && serverId
            ? () => onReauthMcp(catalogId, serverId)
            : undefined
        }
      />
    );
  }

  if (authState?.kind === "auth-required") {
    const { catalogId } = authState;
    return (
      <AuthRequiredTool
        toolName={toolName}
        catalogName={authState.catalogName}
        installUrl={authState.installUrl}
        onInstall={
          onInstallMcp && catalogId ? () => onInstallMcp(catalogId) : undefined
        }
      />
    );
  }

  return null;
}

function hasMessageAuthToolError(message: UIMessage): boolean {
  return hasToolPartsWithAuthErrors(
    (message.parts ?? []).flatMap((part) => {
      if (!isToolPart(part)) {
        return [];
      }

      return [
        {
          output: part.output,
          errorText: getToolErrorText({ part, toolResultPart: null }),
        },
      ];
    }),
  );
}

function buildMessageTimeline(params: {
  messages: UIMessage[];
  chatErrors: PersistedChatError[];
}): TimelineItem[] {
  const sortedChatErrors = [...params.chatErrors].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  const timelineItems: TimelineItem[] = [];
  let errorIndex = 0;

  params.messages.forEach((message, messageIndex) => {
    const messageCreatedAt = getMessageCreatedAt(message);
    while (
      errorIndex < sortedChatErrors.length &&
      messageCreatedAt !== null &&
      Date.parse(sortedChatErrors[errorIndex].createdAt) <= messageCreatedAt
    ) {
      timelineItems.push({
        kind: "chat-error",
        chatError: sortedChatErrors[errorIndex],
      });
      errorIndex++;
    }

    timelineItems.push({ kind: "message", message, messageIndex });
  });

  for (; errorIndex < sortedChatErrors.length; errorIndex++) {
    timelineItems.push({
      kind: "chat-error",
      chatError: sortedChatErrors[errorIndex],
    });
  }

  return timelineItems;
}

function getMessageCreatedAt(message: UIMessage): number | null {
  const metadata = message.metadata;
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    "createdAt" in metadata &&
    typeof metadata.createdAt === "string"
  ) {
    const createdAt = Date.parse(metadata.createdAt);
    return Number.isNaN(createdAt) ? null : createdAt;
  }

  return null;
}

function getInlineErrorMessage(error: Error): string {
  try {
    const parsed = JSON.parse(error.message);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      return parsed.message;
    }
  } catch {
    // Plain client-side errors are not JSON-encoded.
  }

  return error.message;
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
