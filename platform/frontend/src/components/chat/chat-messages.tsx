import type { UIMessage } from "@ai-sdk/react";
import {
  APP_RENDERING_ARCHESTRA_TOOL_SHORT_NAMES,
  ARCHESTRA_MCP_CATALOG_ID,
  type ArchestraToolShortName,
  type archestraApiTypes,
  ChatMessageMetadataSchema,
  getArchestraAppResourceUri,
  getArchestraToolFullName,
  HOOK_RUN_PART_TYPE,
  isAppRenderingArchestraToolShortName,
  parseFullToolName,
  type ResourceVisibilityScope,
  SWAP_AGENT_FAILED_POKE_TEXT,
  SWAP_AGENT_POKE_PREFIX,
  SWAP_AGENT_POKE_TEXT,
  SWAP_TO_DEFAULT_AGENT_POKE_TEXT,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SWAP_AGENT_FULL_NAME,
  TOOL_SWAP_AGENT_SHORT_NAME,
  TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME,
  TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME,
  TOOL_TODO_WRITE_FULL_NAME,
  TOOL_TODO_WRITE_SHORT_NAME,
} from "@archestra/shared";
import type { ChatStatus, DynamicToolUIPart, ToolUIPart } from "ai";
import { BotIcon, CheckCircleIcon, ClockIcon } from "lucide-react";
import Link from "next/link";
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
import { Loader } from "@/components/ai-elements/loader";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Response } from "@/components/ai-elements/response";
import {
  SectionLabel,
  Tool,
  ToolContent,
  ToolErrorDetails,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  HookRunChip,
  type HookRunChipData,
} from "@/components/chat/hook-run-chip";
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
import { PERSISTED_MESSAGE_ID_METADATA_KEY } from "@/lib/chat/chat-utils";
import { useGlobalChat } from "@/lib/chat/global-chat.context";
import {
  hasToolPartsWithAuthErrors,
  isAuthInstructionText,
  isInstallAuthResolved,
  parsePolicyDenied,
  resolveAssistantTextAuthState,
  resolveToolAuthState,
  type ToolAuthState,
} from "@/lib/chat/mcp-error-ui";
import { hasThinkingTags, parseThinkingTags } from "@/lib/chat/parse-thinking";
import {
  getSwapToolShortName,
  type SwapToolPart,
} from "@/lib/chat/swap-agent.utils";
import type { ModelSource } from "@/lib/chat/use-chat-preferences";
import { useAppIconLogo } from "@/lib/hooks/use-app-name";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpInstallOrchestrator } from "@/lib/mcp/mcp-install-orchestrator.hook";
import { useOrganization } from "@/lib/organization.query";
import { cn } from "@/lib/utils";
import { AuthErrorTool, type AuthErrorToolProps } from "./auth-error-tool";
import {
  collectSubagentToolCalls,
  extractFileAttachments,
  extractOwnedAppRender,
  filterOptimisticToolCalls,
  hasTextPart,
  identifyCompactToolGroups,
  isBlankAssistantTextPart,
  resolveRunToolTargetName,
  type SubagentChildEntry,
} from "./chat-messages.utils";
import { CompactToolGroup, type ToolIconMap } from "./compact-tool-call";
import { EditableAssistantMessage } from "./editable-assistant-message";
import { EditableUserMessage } from "./editable-user-message";
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
import {
  getSwapAgentBoundaryLabel,
  SwapAgentBoundaryDivider,
} from "./swap-agent-boundary";
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
  onRegenerateUserMessage?: (args: {
    messageId: string;
    partIndex: number;
    text: string;
  }) => Promise<void>;
  /** Re-run the original prompt after the user connects a per-user provider. */
  onProviderConnected?: () => void;
  /**
   * Scheduled-run only: clear a persisted chat error and resend the prompt.
   * When set, the inline error card shows a "Try again" button.
   */
  onChatErrorRetry?: () => void | Promise<void>;
  error?: Error | null;
  chatErrors?: archestraApiTypes.GetChatConversationResponses["200"]["chatErrors"];
  compactions?: archestraApiTypes.GetChatConversationResponses["200"]["compactions"];
  /** Callback for tool approval responses (approve/deny) */
  onToolApprovalResponse?: (params: {
    id: string;
    approved: boolean;
    reason?: string;
  }) => void;
  agentName?: string;
  selectedModel?: string;
  modelSource?: ModelSource | null;
  isContextCompacting?: boolean;
  contextCompactionFeedback?: {
    status: "pending" | "success" | "skipped" | "failed";
    message: string;
  } | null;
  unsafeContextBoundary?: archestraApiTypes.GetInteractionResponses["200"]["unsafeContextBoundary"];
}

type PersistedChatError =
  archestraApiTypes.GetChatConversationResponses["200"]["chatErrors"][number];

type TimelineItem =
  | { kind: "message"; message: UIMessage; messageIndex: number }
  | { kind: "chat-error"; chatError: PersistedChatError }
  | {
      kind: "compaction";
      compaction: archestraApiTypes.GetChatConversationResponses["200"]["compactions"][number];
    };

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
  onRegenerateUserMessage,
  onProviderConnected,
  onChatErrorRetry,
  error = null,
  chatErrors = [],
  compactions = [],
  onToolApprovalResponse,
  agentName,
  selectedModel,
  modelSource,
  isContextCompacting = false,
  contextCompactionFeedback = null,
  unsafeContextBoundary,
}: ChatMessagesProps) {
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
        // Owned-app management tools render the app inline; compact grouping
        // would swallow their parts before MessageTool sees them.
        ...APP_RENDERING_ARCHESTRA_TOOL_SHORT_NAMES.flatMap((shortName) => [
          getArchestraToolFullName(shortName),
          getToolName(shortName),
        ]),
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
  const contextCompaction = session?.contextCompaction;
  const hasPendingMcpElicitation = Boolean(session?.pendingMcpElicitation);

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
    await onRegenerateUserMessage?.({ messageId, partIndex, text: newText });
  };

  const pendingToolCalls = useMemo(
    () => filterOptimisticToolCalls(messages, optimisticToolCalls),
    [messages, optimisticToolCalls],
  );
  const [unsafeBoundaryEl, setUnsafeBoundaryEl] =
    useState<HTMLDivElement | null>(null);
  const unsafeBoundaryRef = useCallback((node: HTMLDivElement | null) => {
    setUnsafeBoundaryEl(node);
  }, []);
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
    const boundaryElement = unsafeBoundaryEl;
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
  }, [unsafeBoundaryEl]);

  const assistantMessageCount = useMemo(
    () => messages.filter((m) => m.role === "assistant").length,
    [messages],
  );

  // A delegated child agent's tool calls, keyed by the delegation call that
  // spawned them, collected across the whole conversation so a part's storage
  // location never affects how it nests. A delegation tool call whose id is a
  // key here renders its children nested beneath it (recursively).
  const subagentToolCalls = useMemo(
    () => collectSubagentToolCalls(messages),
    [messages],
  );
  const subagentParentToolCallIds = useMemo(
    () => new Set(subagentToolCalls.keys()),
    [subagentToolCalls],
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
  const timelineItems = buildMessageTimeline({
    messages,
    chatErrors,
    compactions,
  });
  const liveErrorMessage = error ? getInlineErrorMessage(error) : null;
  const hasRenderedLiveError =
    !!error &&
    chatErrors.some(
      (chatError) => chatError.error.message === liveErrorMessage,
    );
  // Retrying resends the *last* user turn, so only a persisted error with no
  // message after it (the failed latest turn) may offer a retry — an older error
  // card between messages would otherwise rerun the wrong turn.
  const lastMessageTimelineIndex = timelineItems.reduce(
    (last, item, index) => (item.kind === "message" ? index : last),
    -1,
  );

  let unsafeContextDividerEmitted = false;
  const claimUnsafeContextDivider = (): boolean => {
    if (unsafeContextDividerEmitted) {
      return false;
    }
    unsafeContextDividerEmitted = true;
    return true;
  };

  return (
    <Conversation
      className="h-full"
      resize={instantResize || initialLoad ? "instant" : "smooth"}
    >
      <ScrollToBottomOnSubmit status={status} />
      <ScrollToBottomOnContextCompaction
        isCompacting={contextCompaction?.isCompacting || isContextCompacting}
        feedback={contextCompactionFeedback}
      />
      <ConversationContent>
        <div className="max-w-4xl mx-auto relative pb-8">
          <SensitiveContextStickyIndicator
            visible={showStickyUnsafeIndicator}
          />
          {unsafeContextBoundary?.kind === "preexisting_untrusted" && (
            <PreexistingUnsafeContextDivider dividerRef={unsafeBoundaryRef} />
          )}
          {timelineItems.map((item, index) => {
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
                  onProviderConnected={onProviderConnected}
                  onRetry={
                    index > lastMessageTimelineIndex
                      ? onChatErrorRetry
                      : undefined
                  }
                />
              );
            }

            if (item.kind === "compaction") {
              return (
                <ContextCompactionTimelineEvent
                  key={`compaction-${item.compaction.id}`}
                  compaction={item.compaction}
                />
              );
            }

            const { message, messageIndex: idx } = item;
            // Hide the auto-poke message sent after agent swap
            if (!isDebugging && isSwapAgentPokeMessage(message)) return null;

            const isDimmed =
              editingMessageIndex !== -1 && idx > editingMessageIndex;
            const previousSwapBoundaryLabel =
              message.role === "assistant"
                ? getPreviousAssistantSwapBoundaryLabel({
                    messages,
                    beforeIndex: idx,
                    getToolShortName,
                    hasToolError: hasSwapToolError,
                  })
                : null;

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
                        parts: group.entries.flatMap((entry) =>
                          entry.kind === "tool"
                            ? [entry.toolResultPart ?? entry.part]
                            : [],
                        ),
                        dividerRef: unsafeBoundaryRef,
                        unsafeContextBoundary,
                        canReadToolPolicy: !!canReadToolPolicy,
                        claimUnsafeContextDivider,
                        renderedPart: (
                          <CompactToolGroup
                            key={getCompactGroupKey(
                              message.id,
                              group.startIndex,
                            )}
                            tools={group.entries.map((entry) =>
                              entry.kind === "hook"
                                ? {
                                    kind: "hook" as const,
                                    key: `${message.id}-hook-${entry.partIndex}`,
                                    data: entry.data,
                                  }
                                : {
                                    kind: "tool" as const,
                                    key: getToolEntryKey(message.id, entry),
                                    toolName: entry.toolName,
                                    part: entry.part,
                                    toolResultPart: entry.toolResultPart,
                                    errorText: entry.errorText,
                                    nestedToolCalls:
                                      subagentParentToolCallIds.has(
                                        entry.part.toolCallId ?? "",
                                      ) ? (
                                        <SubagentToolCalls
                                          parentToolCallId={
                                            entry.part.toolCallId ?? ""
                                          }
                                          subagentToolCalls={subagentToolCalls}
                                          isDebugging={isDebugging}
                                          canExpandToolCalls={
                                            canExpandToolCalls
                                          }
                                          connectedCatalogIds={
                                            orchestrator.connectedCatalogIds
                                          }
                                          getToolShortName={getToolShortName}
                                          toolIconMap={toolIconMap}
                                        />
                                      ) : null,
                                  },
                            )}
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
                        // Skip blank text parts from assistant messages. Models
                        // routinely stream a whitespace-only chunk (" ", "\n\n")
                        // right before a tool call, which the AI SDK turns into a
                        // text part; rendered, it shows as an empty message bubble.
                        // Trims so whitespace-only — not just "" — is suppressed.
                        if (isBlankAssistantTextPart(part, message.role)) {
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
                            connectedCatalogIds:
                              orchestrator.connectedCatalogIds,
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
                                skill={
                                  ChatMessageMetadataSchema.safeParse(
                                    message.metadata,
                                  ).data?.skill
                                }
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
                                skill={
                                  ChatMessageMetadataSchema.safeParse(
                                    message.metadata,
                                  ).data?.skill
                                }
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
                            className="mb-4 flex justify-start"
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
                                <Link
                                  href={filePart.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  download={filePart.filename}
                                  className="flex items-center gap-2 text-sm rounded-lg border bg-muted/50 p-2 hover:bg-muted transition-colors"
                                >
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
                                </Link>
                              )}
                              {!isImage && !isVideo && !isPdf && (
                                <a
                                  href={filePart.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  download={filePart.filename}
                                  className="flex items-center gap-2 text-sm rounded-lg border bg-muted/50 p-2 hover:bg-muted transition-colors"
                                >
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
                                </a>
                              )}
                            </div>
                          </div>
                        );
                      }

                      case "dynamic-tool": {
                        if (!isToolPart(part)) return null;
                        const toolName = part.toolName;

                        // Skip if a data-tool-ui-start already owns this toolCallId
                        // (it renders the full input/output lifecycle itself).
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
                          claimUnsafeContextDivider,
                          renderedPart: (
                            // Shallow-copy so MessageTool's by-value memo
                            // comparator sees a distinct object: the AI SDK
                            // mutates a tool part in place (same reference) when
                            // its result lands, which otherwise hides the
                            // input-available -> output-available transition.
                            <MessageTool
                              part={{ ...part }}
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
                              connectedCatalogIds={
                                orchestrator.connectedCatalogIds
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
                        // Inline hook-run debug entry (a model-invisible
                        // `data-hook-run` part the backend splices into the turn).
                        if (part.type === HOOK_RUN_PART_TYPE) {
                          return (
                            <HookRunChip
                              key={partKey}
                              data={(part as { data?: HookRunChipData }).data}
                            />
                          );
                        }

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
                            claimUnsafeContextDivider,
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
                                connectedCatalogIds={
                                  orchestrator.connectedCatalogIds
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
                            claimUnsafeContextDivider,
                            renderedPart: (
                              // Shallow-copy so MessageTool's by-value memo
                              // comparator sees a distinct object: the AI SDK
                              // mutates a tool part in place (same reference)
                              // when its result lands, which otherwise hides the
                              // input-available -> output-available transition.
                              <MessageTool
                                key={partKey}
                                part={{ ...part }}
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
                                connectedCatalogIds={
                                  orchestrator.connectedCatalogIds
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
                                nestedToolCalls={
                                  tcId &&
                                  subagentParentToolCallIds.has(tcId) ? (
                                    <SubagentToolCalls
                                      parentToolCallId={tcId}
                                      subagentToolCalls={subagentToolCalls}
                                      isDebugging={isDebugging}
                                      canExpandToolCalls={canExpandToolCalls}
                                      connectedCatalogIds={
                                        orchestrator.connectedCatalogIds
                                      }
                                      getToolShortName={getToolShortName}
                                      toolIconMap={toolIconMap}
                                    />
                                  ) : null
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
                    suppressLabel={previousSwapBoundaryLabel}
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
              onProviderConnected={onProviderConnected}
              onRetry={onChatErrorRetry}
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
              connectedCatalogIds={orchestrator.connectedCatalogIds}
              getToolShortName={getToolShortName}
              toolIconMap={toolIconMap}
            />
          ))}
          <ContextCompactionStatus
            isCompacting={
              contextCompaction?.isCompacting || isContextCompacting
            }
            feedback={contextCompactionFeedback}
          />
          {isResponseInProgress && !hasPendingMcpElicitation && (
            <div className="absolute bottom-[-10] left-0">
              <Message from="assistant">
                <img
                  src={appIconLogo}
                  alt="Loading logo"
                  className="h-6 w-auto object-contain [animation:archestra-chat-logo-bounce_700ms_ease-in-out_200ms_infinite]"
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

function ScrollToBottomOnContextCompaction({
  isCompacting,
  feedback,
}: {
  isCompacting: boolean;
  feedback: ChatMessagesProps["contextCompactionFeedback"];
}) {
  const { scrollToBottom } = useStickToBottomContext();
  const statusKey = isCompacting
    ? "pending"
    : feedback
      ? `${feedback.status}:${feedback.message}`
      : null;

  useEffect(() => {
    if (statusKey) {
      scrollToBottom();
    }
  }, [scrollToBottom, statusKey]);

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
    connectedCatalogIds,
    getToolShortName,
    onSendMessage,
    earlyToolUiData,
    toolIconMap,
    nestedToolCalls,
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
    connectedCatalogIds: ReadonlySet<string>;
    getToolShortName: (toolName: string) => ArchestraToolShortName | null;
    onSendMessage?: (text: string) => void;
    toolIconMap?: ToolIconMap;
    // Delegation cards only: the surfaced subagent tool calls, rendered between
    // this card's Request and Result so the delegation reads in causal order
    // (prompt in -> child tools run -> answer out).
    nestedToolCalls?: React.ReactNode;
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
    const uiMeta = mcpOutput?._meta?.ui as
      | { resourceUri?: string; mcpServerId?: string }
      | undefined;
    const uiResourceUri = uiMeta?.resourceUri ?? earlyToolUiData?.uiResourceUri;
    // A server-scoped deep link (apps-page open-in-chat) stamps the concrete
    // install so the chat mounts against it instead of the agent gateway.
    const uiMcpServerId = uiMeta?.mcpServerId;

    // When the model dispatched through run_tool, the MCP App belongs to the
    // *target* tool. Unwrap so the app receives the target tool's name (for the
    // sandbox origin and tool callbacks) and its real arguments (e.g. Excalidraw
    // elements) instead of the run_tool wrapper.
    const runToolInput =
      getToolShortName(toolName) === TOOL_RUN_TOOL_SHORT_NAME
        ? (part.input as {
            tool_name?: string;
            tool_args?: Record<string, unknown>;
          } | null)
        : null;
    const mcpAppToolName = resolveRunToolTargetName(part, toolName, {
      getToolShortName,
    });
    const mcpAppToolInput =
      runToolInput?.tool_args ?? (part.input as Record<string, unknown>);

    // Use the text content string when available; fall back to the raw output for non-MCP tools.
    const output = mcpOutput?.content ?? rawOutput;
    const errorText = getToolErrorText({ part, toolResultPart });

    // Owned-app management result (create/update/render_app): mount the
    // app-bound runtime from structuredContent.id. Standard UI resources,
    // errors, and denials take priority — those results keep their text.
    const ownedApp =
      !uiResourceUri && !errorText && part.state !== "output-denied"
        ? extractOwnedAppRender({
            toolName: mcpAppToolName,
            output: rawOutput,
            getToolShortName,
          })
        : null;

    // An owned-app management tool (scaffold/edit/render_app), detected by name
    // even before its result lands. Lets the still-pending call render as the
    // same compact Archestra-logo circle as the finished one, instead of the
    // full-width tool card it would otherwise fall through to.
    const appMgmtShortName = getToolShortName(mcpAppToolName);
    const isOwnedAppMgmtTool =
      appMgmtShortName !== null
        ? isAppRenderingArchestraToolShortName(appMgmtShortName)
        : isAppRenderingArchestraToolShortName(mcpAppToolName);

    const isApprovalRequested = part.state === "approval-requested";
    const isToolDenied = part.state === "output-denied";
    const approvalDisplay = getApprovalToolDisplay({
      toolName,
      input: part.input,
      isApprovalRequested,
      getToolShortName,
    });
    const displayToolName = approvalDisplay.toolName;
    const displayInput = approvalDisplay.input;
    const hasInput = displayInput && Object.keys(displayInput).length > 0;
    const hasNestedToolCalls = Boolean(nestedToolCalls);
    const hasContent = Boolean(
      hasInput ||
        errorText ||
        isApprovalRequested ||
        hasNestedToolCalls ||
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
      connectedCatalogIds,
      onInstallMcp,
      onReauthMcp,
    });

    // Successful swap_agent / swap_to_default_agent calls are rendered as dividers after all message parts.
    // Failed/no-op swap calls use the compact tool status indicator so they do not render a false divider.
    // Show the raw tool call when the user's name ends with "(debugging)".
    const swapToolShortName = getSwapToolShortName({
      toolName,
      getToolShortName,
    });
    const isSwapTool =
      swapToolShortName === TOOL_SWAP_AGENT_SHORT_NAME ||
      swapToolShortName === TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME;
    if (!isDebugging && isSwapTool) {
      return errorText ? (
        <CompactToolGroup
          tools={[
            {
              kind: "tool",
              key: part.toolCallId ?? toolName,
              toolName,
              part,
              toolResultPart,
              errorText,
            },
          ]}
          toolIconMap={toolIconMap}
          canExpandToolCalls={canExpandToolCalls}
          onToolApprovalResponse={onToolApprovalResponse}
        />
      ) : null;
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
      // Unwrap run_tool so the circle carries the target tool's server icon.
      const shortName = parseFullToolName(mcpAppToolName).toolName.replace(
        /_/g,
        " ",
      );
      const iconInfo = toolIconMap?.get(mcpAppToolName);

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

    // MCP App tools: compact circle + canvas below (no collapsible wrapper).
    // Owned-app management tools use this compact form even while pending (before
    // a result identifies the app), so "Edit app" streaming looks like every
    // other tool call rather than a full-width card.
    if (
      (uiResourceUri || ownedApp || isOwnedAppMgmtTool) &&
      !isApprovalRequested &&
      !isToolDenied &&
      !errorText
    ) {
      const compactState = getCompactToolState({ part, toolResultPart });
      // Unwrap run_tool so the circle carries the target tool's server icon.
      const shortName = parseFullToolName(mcpAppToolName).toolName.replace(
        /_/g,
        " ",
      );
      const iconInfo = toolIconMap?.get(mcpAppToolName);
      // Fall back to the Archestra catalog icon for owned-app / archestra tools
      // whose icon isn't in the map yet (e.g. a still-pending management call).
      const catalogId =
        iconInfo?.catalogId ??
        (appMgmtShortName !== null ? ARCHESTRA_MCP_CATALOG_ID : undefined);

      // Expanded tool-call details (input/output). Handed to McpAppSection so it
      // can place them above the app in the column below the circle+marker row.
      const toolDetails = isOpen ? (
        <Tool defaultOpen={true}>
          <ToolHeader
            type={`tool-${displayToolName}`}
            state={getHeaderState({
              state: part.state || "input-available",
              toolResultPart,
              errorText,
            })}
            isCollapsible={!!hasInput}
          />
          <ToolContent>
            {hasInput ? <ToolInput input={displayInput} /> : null}
            {toolResultPart && (
              <ToolOutput
                label="Result"
                output={mcpOutput?.content ?? toolResultPart.output}
              />
            )}
          </ToolContent>
        </Tool>
      ) : undefined;

      // Tool-call circle and the app marker share the flex-wrap row's first line;
      // the tool details + inline app card stack in a full-width column below.
      return (
        <div className="mb-4">
          <div className="flex flex-wrap items-start gap-1.5">
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
                    {iconInfo?.icon || catalogId ? (
                      <McpCatalogIcon
                        icon={iconInfo?.icon}
                        catalogId={catalogId}
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
            {agentId &&
              (uiResourceUri ? (
                <McpAppSection
                  uiResourceUri={uiResourceUri}
                  mcpServerId={uiMcpServerId}
                  agentId={agentId}
                  toolName={mcpAppToolName}
                  toolCallId={part.toolCallId}
                  toolInput={mcpAppToolInput}
                  rawOutput={mcpOutput}
                  toolDetails={toolDetails}
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
              ) : ownedApp ? (
                <McpAppSection
                  uiResourceUri={getArchestraAppResourceUri(ownedApp.appId)}
                  appId={ownedApp.appId}
                  appName={ownedApp.appName}
                  appVersion={ownedApp.latestVersion}
                  agentId={agentId}
                  toolName={mcpAppToolName}
                  toolCallId={part.toolCallId}
                  toolDetails={toolDetails}
                  onSendMessage={onSendMessage}
                />
              ) : null)}
          </div>
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
          type={`tool-${displayToolName}`}
          state={getHeaderState({
            state: part.state || "input-available",
            toolResultPart,
            errorText,
          })}
          isCollapsible={isExpandable}
          actionButton={logsButton}
        />
        <ToolContent forceMount={uiResourceUri ? true : undefined}>
          {hasInput ? <ToolInput input={displayInput} /> : null}
          {nestedToolCalls}
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
                mcpServerId={uiMcpServerId}
                agentId={agentId}
                toolName={mcpAppToolName}
                toolCallId={part.toolCallId}
                toolInput={mcpAppToolInput}
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
    // Delegation cards carry freshly-built nested subagent content the by-value
    // checks below can't see; never skip their renders or late-arriving child
    // tool calls would be dropped.
    !prev.nestedToolCalls &&
    !next.nestedToolCalls &&
    // Skip re-render unless identity, state, or UI-relevant data actually changed.
    // Compare by value, not reference: the AI SDK sometimes mutates a tool part
    // in place when its result lands, so render sites pass a shallow copy (see
    // MessageTool usages) to keep these by-value checks meaningful. During
    // input-streaming, also re-render on input growth.
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

function getApprovalToolDisplay({
  toolName,
  input,
  isApprovalRequested,
  getToolShortName,
}: {
  toolName: string;
  input: unknown;
  isApprovalRequested: boolean;
  getToolShortName: (toolName: string) => ArchestraToolShortName | null;
}): {
  toolName: string;
  input: Record<string, unknown> | undefined;
} {
  const displayInput = isPlainRecord(input) ? input : undefined;
  const shortToolName =
    getToolShortName(toolName) ?? parseFullToolName(toolName).toolName;

  if (!isApprovalRequested || shortToolName !== TOOL_RUN_TOOL_SHORT_NAME) {
    return {
      toolName,
      input: displayInput,
    };
  }

  if (!displayInput) {
    return {
      toolName,
      input: undefined,
    };
  }

  const targetToolName = displayInput.tool_name;
  if (typeof targetToolName !== "string" || targetToolName.length === 0) {
    return {
      toolName,
      input: displayInput,
    };
  }

  return {
    toolName: targetToolName,
    input: isPlainRecord(displayInput.tool_args)
      ? displayInput.tool_args
      : undefined,
  };
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function getPreviousAssistantSwapBoundaryLabel({
  messages,
  beforeIndex,
  getToolShortName,
  hasToolError,
}: {
  messages: UIMessage[];
  beforeIndex: number;
  getToolShortName?: (toolName: string) => ArchestraToolShortName | null;
  hasToolError: (part: SwapToolPart, allParts: SwapToolPart[]) => boolean;
}) {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const previousMessage = messages[i];
    if (previousMessage.role === "user") {
      return null;
    }
    if (previousMessage.role !== "assistant") {
      continue;
    }

    const label = getSwapAgentBoundaryLabel({
      parts: previousMessage.parts ?? [],
      getToolShortName,
      hasToolError,
    });
    if (label) {
      return label;
    }
  }

  return null;
}

/** Synthesize a tool UI part from a surfaced subagent call so the existing tool card renders it. */
function synthesizeSubagentToolPart(
  entry: SubagentChildEntry,
): ToolUIPart | DynamicToolUIPart {
  const state = entry.errorText
    ? "output-error"
    : (entry.state ?? "output-available");
  return {
    type: `tool-${entry.toolName}`,
    toolCallId: entry.toolCallId,
    state,
    input: entry.input,
    output: entry.output,
    ...(entry.errorText ? { errorText: entry.errorText } : {}),
  } as ToolUIPart;
}

// Guards against a malformed parent/child map producing unbounded recursion;
// real toolCallIds are unique, so a well-formed map is always a finite tree.
const MAX_SUBAGENT_NESTING_DEPTH = 16;

/**
 * Render a delegation call's surfaced subagent tool calls as an indented rail.
 * The caller places this between the delegation card's Request and Result, so the
 * card reads in causal order. Each child reuses the standard tool card; a child
 * that is itself a delegation (its id has its own children) recurses into that
 * child's own Request/Result, mirroring the delegation chain. Renders nothing
 * when the delegation produced no surfaced tool calls.
 */
function SubagentToolCalls({
  parentToolCallId,
  subagentToolCalls,
  depth = 0,
  isDebugging,
  canExpandToolCalls,
  connectedCatalogIds,
  getToolShortName,
  toolIconMap,
}: {
  parentToolCallId: string;
  subagentToolCalls: Map<string, SubagentChildEntry[]>;
  depth?: number;
  isDebugging?: boolean;
  canExpandToolCalls?: boolean;
  connectedCatalogIds: ReadonlySet<string>;
  getToolShortName: (toolName: string) => ArchestraToolShortName | null;
  toolIconMap?: ToolIconMap;
}) {
  const children = subagentToolCalls.get(parentToolCallId);
  if (!children?.length || depth >= MAX_SUBAGENT_NESTING_DEPTH) {
    return null;
  }
  return (
    <div className="pt-2 space-y-1.5">
      <div className="px-3">
        <SectionLabel accent="bg-violet-400">Tools</SectionLabel>
      </div>
      <div className="px-3 space-y-1">
        {children.map((child) => (
          /* Display-only: a subagent's calls are completed, autonomous child
           activity. agentId and the approval/auth/install callbacks are
           intentionally omitted so an agent-scoped action can't fire against
           the parent agent (the child ran the tool, not the parent). A child
           that is itself a delegation nests its own children between its
           Request and Result, recursing the same layout. */
          <MessageTool
            key={child.toolCallId}
            part={synthesizeSubagentToolPart(child)}
            toolResultPart={null}
            toolName={child.toolName}
            isDebugging={isDebugging}
            canExpandToolCalls={canExpandToolCalls}
            connectedCatalogIds={connectedCatalogIds}
            getToolShortName={getToolShortName}
            toolIconMap={toolIconMap}
            nestedToolCalls={
              subagentToolCalls.has(child.toolCallId) ? (
                <SubagentToolCalls
                  parentToolCallId={child.toolCallId}
                  subagentToolCalls={subagentToolCalls}
                  depth={depth + 1}
                  isDebugging={isDebugging}
                  canExpandToolCalls={canExpandToolCalls}
                  connectedCatalogIds={connectedCatalogIds}
                  getToolShortName={getToolShortName}
                  toolIconMap={toolIconMap}
                />
              ) : null
            }
          />
        ))}
      </div>
    </div>
  );
}

function renderPartWithUnsafeContextDivider({
  partKey,
  part,
  renderedPart,
  dividerRef,
  unsafeContextBoundary,
  canReadToolPolicy,
  claimUnsafeContextDivider,
}: {
  partKey: string;
  part: DynamicToolUIPart | ToolUIPart;
  renderedPart: React.ReactNode;
  dividerRef: React.Ref<HTMLDivElement>;
  unsafeContextBoundary?: archestraApiTypes.GetInteractionResponses["200"]["unsafeContextBoundary"];
  canReadToolPolicy: boolean;
  claimUnsafeContextDivider: () => boolean;
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

  if (!claimUnsafeContextDivider()) {
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
  claimUnsafeContextDivider,
}: {
  partKey: string;
  parts: Array<DynamicToolUIPart | ToolUIPart>;
  renderedPart: React.ReactNode;
  dividerRef: React.Ref<HTMLDivElement>;
  unsafeContextBoundary?: archestraApiTypes.GetInteractionResponses["200"]["unsafeContextBoundary"];
  canReadToolPolicy: boolean;
  claimUnsafeContextDivider: () => boolean;
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

  if (!claimUnsafeContextDivider()) {
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

// Names which credential expired on the re-authentication card. The returned
// subject is grammatically the plural "credentials" so it reads naturally with
// the "… have expired or are invalid" copy that follows. Falls back to the
// scope-less "Your credentials" when the resolved scope is unknown (text-parsed
// errors, or chat history predating the structured field).
function expiredCredentialSubject(params: {
  scope?: ResourceVisibilityScope;
  teamName?: string | null;
}): React.ReactNode {
  const { scope, teamName } = params;

  if (scope === "personal") {
    return (
      <>
        Your <span className="font-medium">personal</span> credentials
      </>
    );
  }

  if (scope === "team") {
    return teamName ? (
      <>
        The <span className="font-medium">{teamName}</span> team&rsquo;s
        credentials
      </>
    ) : (
      <>
        Your <span className="font-medium">team&rsquo;s</span> credentials
      </>
    );
  }

  if (scope === "org") {
    return (
      <>
        The <span className="font-medium">organization&rsquo;s</span>{" "}
        credentials
      </>
    );
  }

  return <>Your credentials</>;
}

function authCardProps(params: {
  toolName: string;
  authState: ToolAuthState | null;
  connectedCatalogIds: ReadonlySet<string>;
  onInstall?: () => void;
  onReauth?: () => void;
}): AuthErrorToolProps | null {
  const { authState, toolName, connectedCatalogIds, onInstall, onReauth } =
    params;

  // Once the user connects a server for this catalog, the install prompt is
  // resolved — flip it to a connected state instead of an outstanding error.
  if (
    authState?.kind === "auth-required" &&
    isInstallAuthResolved({ authState, connectedCatalogIds })
  ) {
    return {
      title: "Authentication successful",
      description: <>Connected to &ldquo;{authState.catalogName}&rdquo;.</>,
      variant: "success",
    };
  }

  switch (authState?.kind) {
    case "auth-expired": {
      const displayName = authState.catalogName || toolName || "this tool";
      return {
        title: "Expired / Invalid Authentication",
        description: (
          <>
            {expiredCredentialSubject({
              scope: authState.credentialScope,
              teamName: authState.credentialTeamName,
            })}{" "}
            for &ldquo;{displayName}&rdquo; have expired or are invalid.
            Re-authenticate to continue using this tool.
          </>
        ),
        buttonText: onReauth ? "Re-authenticate" : "Manage credentials",
        buttonUrl: authState.reauthUrl,
        onAction: onReauth,
        actionTooltipText: onReauth
          ? `This will redirect you to ${displayName} to authorize access, then return you to this chat.`
          : undefined,
      };
    }
    case "assigned-credential-unavailable":
      return {
        title: "Expired / Invalid Authentication",
        description: (
          <>
            credentials for &ldquo;{authState.catalogName}&rdquo; have expired
            or are invalid. Re-authenticate to continue using this tool. Ask the
            agent owner or an admin to re-authenticate.
          </>
        ),
      };
    case "auth-required": {
      const isIdentityProviderConnect =
        authState.action === "connect_identity_provider";
      const providerName = authState.providerId ?? "identity provider";
      return {
        title: "Authentication Required",
        description: isIdentityProviderConnect ? (
          `Connect ${providerName}. This deployment can then request the downstream credential for "${authState.catalogName}".`
        ) : (
          <>
            No credentials found for &ldquo;{authState.catalogName}&rdquo;. Set
            up your credentials to use this tool.
          </>
        ),
        buttonText: isIdentityProviderConnect
          ? `Connect ${providerName}`
          : "Set up credentials",
        buttonUrl: authState.actionUrl,
        onAction: isIdentityProviderConnect ? undefined : onInstall,
        openInNewTab: !isIdentityProviderConnect,
      };
    }
    default:
      return null;
  }
}

function resolveAuthActions(params: {
  authState: ToolAuthState | null;
  onInstallMcp?: (catalogId: string) => void;
  onReauthMcp?: (catalogId: string, serverId: string) => void;
}): { onInstall?: () => void; onReauth?: () => void } {
  const { authState, onInstallMcp, onReauthMcp } = params;

  if (authState?.kind === "auth-expired") {
    const { catalogId, serverId } = authState;
    return {
      onReauth:
        onReauthMcp && catalogId && serverId
          ? () => onReauthMcp(catalogId, serverId)
          : undefined,
    };
  }

  if (authState?.kind === "auth-required") {
    const { catalogId } = authState;
    return {
      onInstall:
        authState.action === "install_mcp_credentials" &&
        onInstallMcp &&
        catalogId
          ? () => onInstallMcp(catalogId)
          : undefined,
    };
  }

  return {};
}

function renderToolAuthPart(params: {
  toolName: string;
  authState: ReturnType<typeof resolveToolAuthState>;
  connectedCatalogIds: ReadonlySet<string>;
  onInstallMcp?: (catalogId: string) => void;
  onReauthMcp?: (catalogId: string, serverId: string) => void;
}) {
  const {
    authState,
    toolName,
    connectedCatalogIds,
    onInstallMcp,
    onReauthMcp,
  } = params;
  const actions = resolveAuthActions({ authState, onInstallMcp, onReauthMcp });
  const props = authCardProps({
    toolName,
    authState,
    connectedCatalogIds,
    ...actions,
  });
  return props ? <AuthErrorTool {...props} /> : null;
}

function renderAssistantAuthPart(params: {
  toolName: string;
  authState: ReturnType<typeof resolveAssistantTextAuthState>;
  connectedCatalogIds: ReadonlySet<string>;
  onInstallMcp?: (catalogId: string) => void;
  onReauthMcp?: (catalogId: string, serverId: string) => void;
}) {
  return renderToolAuthPart(params);
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
  compactions: ChatMessagesProps["compactions"];
}): TimelineItem[] {
  const sortedChatErrors = [...params.chatErrors].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  const compactionsByBoundary = new Map<
    string,
    NonNullable<ChatMessagesProps["compactions"]>
  >();
  const unanchoredCompactions: NonNullable<ChatMessagesProps["compactions"]> =
    [];
  for (const compaction of params.compactions ?? []) {
    if (compaction.compactedThroughMessageId) {
      const existing =
        compactionsByBoundary.get(compaction.compactedThroughMessageId) ?? [];
      existing.push(compaction);
      compactionsByBoundary.set(compaction.compactedThroughMessageId, existing);
    } else {
      unanchoredCompactions.push(compaction);
    }
  }

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
    for (const boundaryId of getMessageCompactionBoundaryIds(message)) {
      for (const compaction of compactionsByBoundary.get(boundaryId) ?? []) {
        timelineItems.push({ kind: "compaction", compaction });
      }
    }
  });

  for (; errorIndex < sortedChatErrors.length; errorIndex++) {
    timelineItems.push({
      kind: "chat-error",
      chatError: sortedChatErrors[errorIndex],
    });
  }

  for (const compaction of unanchoredCompactions) {
    timelineItems.push({ kind: "compaction", compaction });
  }

  return timelineItems;
}

function getMessageCompactionBoundaryIds(message: UIMessage): string[] {
  const ids = [message.id];
  const metadata = message.metadata;
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    PERSISTED_MESSAGE_ID_METADATA_KEY in metadata &&
    typeof metadata[PERSISTED_MESSAGE_ID_METADATA_KEY] === "string" &&
    metadata[PERSISTED_MESSAGE_ID_METADATA_KEY] !== message.id
  ) {
    ids.push(metadata[PERSISTED_MESSAGE_ID_METADATA_KEY]);
  }

  return ids;
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

function ContextCompactionStatus({
  isCompacting,
  feedback,
}: {
  isCompacting: boolean;
  feedback: ChatMessagesProps["contextCompactionFeedback"];
}) {
  if (isCompacting || feedback?.status === "pending") {
    return (
      <div className="mb-4 flex justify-center">
        <div className="inline-flex items-center gap-2 rounded-full border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          <Loader size={16} />
          <span>Compacting conversation context...</span>
        </div>
      </div>
    );
  }

  if (!feedback) {
    return null;
  }

  const icon =
    feedback.status === "success" ? (
      <CheckCircleIcon className="size-4 text-emerald-500" />
    ) : (
      <ClockIcon className="size-4 text-muted-foreground" />
    );

  return (
    <div className="mb-4 flex justify-center">
      <div className="inline-flex items-center gap-2 rounded-full border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        {icon}
        <span>{feedback.message}</span>
      </div>
    </div>
  );
}

function ContextCompactionTimelineEvent({
  compaction,
}: {
  compaction: NonNullable<ChatMessagesProps["compactions"]>[number];
}) {
  const createdAt = new Date(compaction.createdAt);
  const timestamp = Number.isNaN(createdAt.getTime())
    ? null
    : createdAt.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });

  return (
    <div className="my-4 flex justify-center">
      <div className="inline-flex max-w-full items-center gap-2 rounded-full border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        <CheckCircleIcon className="size-4 text-emerald-500" />
        <span>Conversation context compacted</span>
        {timestamp && (
          <span className="text-muted-foreground/70">{timestamp}</span>
        )}
      </div>
    </div>
  );
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
