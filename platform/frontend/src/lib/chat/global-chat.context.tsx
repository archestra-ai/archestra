"use client";

import { type UIMessage, useChat } from "@ai-sdk/react";
import {
  type ArchestraToolShortName,
  CONTEXT_WINDOW_BREAKDOWN_EVENT,
  type ContextWindowBreakdown,
  ContextWindowBreakdownSchema,
  type ContextWindowEstimate,
  EXTERNAL_AGENT_ID_HEADER,
  getArchestraToolShortName,
  makeSwapAgentPokeText,
  SWAP_AGENT_FAILED_POKE_TEXT,
  SWAP_TO_DEFAULT_AGENT_POKE_TEXT,
  stripDanglingToolCalls,
  TOOL_ARTIFACT_WRITE_SHORT_NAME,
  TOOL_CREATE_AGENT_SHORT_NAME,
  TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_SHORT_NAME,
  TOOL_SWAP_AGENT_SHORT_NAME,
  TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME,
  type TokenUsage,
} from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { filterOptimisticToolCalls } from "@/components/chat/chat-messages.utils";
import {
  type ChatMcpElicitationRequest,
  McpElicitationDialog,
} from "@/components/chat/mcp-elicitation-dialog";
import {
  useClearChatErrors,
  useConversationUpdatedCacheSync,
  useGenerateConversationTitle,
  useResolveChatMcpElicitation,
} from "@/lib/chat/chat.query";
import { useUpdateChatMessage } from "@/lib/chat/chat-message.query";
import {
  isRetryableError,
  parseStructuredChatError,
} from "@/lib/chat/chat-retry.utils";
import {
  pruneEmptyTrailingAssistantMessage,
  restoreRenderableAssistantParts,
  shouldFreezeChatMessages,
} from "@/lib/chat/chat-session-utils";
import {
  applyTextEditToMessages,
  getChatExternalAgentId,
  getConversationDisplayTitle,
  resolveCanonicalMessageId,
} from "@/lib/chat/chat-utils";
import {
  extractSwapTargetAgentName,
  getRenderedToolName,
  getSwapToolShortName,
  hasSwapToolErrorInPart,
} from "@/lib/chat/swap-agent.utils";
import appConfig from "@/lib/config/config";
import { useAppName } from "@/lib/hooks/use-app-name";

const SESSION_CLEANUP_TIMEOUT = 10 * 60 * 1000; // 10 min
const MAX_AUTO_RETRIES = 2;
const AUTO_RETRY_DELAY_MS = 1500;

export type ContextCompactionState = {
  isCompacting: boolean;
  trigger: "auto" | "manual" | null;
  lastCompaction: {
    trigger?: "auto" | "manual";
    compactionId?: string;
    originalTokenEstimate?: number;
    compactedTokenEstimate?: number;
  } | null;
};

type ContextCompactionRecord = NonNullable<
  ContextCompactionState["lastCompaction"]
> & {
  updateContextTokens?: boolean;
};

function isDuplicateActiveRunError(error: Error): boolean {
  // Match the backend's exact duplicate-run message rather than a bare "409",
  // which could collide with unrelated error text (e.g. "4096 tokens").
  return error.message.includes("already has an active response");
}

function shouldResumeActiveRun(messages: UIMessage[]): boolean {
  return messages.at(-1)?.role === "user";
}

interface ChatSession {
  conversationId: string;
  messages: UIMessage[];
  sendMessage: (
    message: Parameters<ReturnType<typeof useChat>["sendMessage"]>[0],
  ) => void;
  /** Re-run the assistant turn for a user message, optionally with edited text. */
  regenerateUserMessage: (args: {
    messageId: string;
    partIndex: number;
    text: string;
  }) => Promise<void>;
  stop: () => void;
  status: "ready" | "submitted" | "streaming" | "error";
  error: Error | undefined;
  setMessages: (messages: UIMessage[]) => void;
  addToolResult: ReturnType<typeof useChat>["addToolResult"];
  addToolApprovalResponse: ReturnType<
    typeof useChat
  >["addToolApprovalResponse"];
  pendingCustomServerToolCall: {
    toolCallId: string;
    toolName: string;
  } | null;
  pendingMcpElicitation: ChatMcpElicitationRequest | null;
  /**
   * True while the session is auto-recovering from a transient stream failure
   * (auto-retry scheduled or reattaching to the still-running response).
   * The UI should not surface the error while this is set — the recovery
   * either restores the stream or ends with a terminal error that clears it.
   */
  isRecovering: boolean;
  optimisticToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
  }>;
  setPendingCustomServerToolCall: (
    value: { toolCallId: string; toolName: string } | null,
  ) => void;
  /** Token usage for the current/last response */
  tokenUsage: TokenUsage | null;
  contextTokensUsed: number | null;
  /** Per-category breakdown of the assembled request for the current turn */
  contextWindow: ContextWindowBreakdown | null;
  contextCompaction: ContextCompactionState;
  recordContextCompaction: (compaction: ContextCompactionRecord) => void;
  /** Early UI data from data-tool-ui-start events (toolCallId → resource data incl. pre-fetched HTML) */
  earlyToolUiStarts: Record<
    string,
    {
      uiResourceUri: string;
      html?: string;
      csp?: { connectDomains?: string[]; resourceDomains?: string[] };
      permissions?: {
        camera?: boolean;
        microphone?: boolean;
        geolocation?: boolean;
        clipboardWrite?: boolean;
      };
      /** Stored to identify PREFETCH entries where the key equals toolName */
      toolName?: string;
    }
  >;
}

interface ChatContextValue {
  registerSession: (params: {
    conversationId: string;
    initialMessages?: UIMessage[];
  }) => void;
  getSession: (conversationId: string) => ChatSession | undefined;
  clearSession: (conversationId: string) => void;
  notifySessionUpdate: () => void;
  scheduleCleanup: (conversationId: string) => void;
  cancelCleanup: (conversationId: string) => void;
  /** Conversation IDs whose title should currently play the typing animation */
  animatingTitleIds: Set<string>;
  /** Mark a conversation's title to play the typing animation (auto-clears after a few seconds) */
  markTitleAnimating: (conversationId: string) => void;
}

/** How long a freshly generated title keeps playing the typing animation */
const TITLE_ANIMATION_DURATION = 3000;

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  // Refresh sidebar unread indicators when the server pushes a message-landed
  // event (covers turns that finish after the client navigated away).
  useConversationUpdatedCacheSync();

  const sessionsRef = useRef(new Map<string, ChatSession>());
  const initialMessagesRef = useRef(new Map<string, UIMessage[]>());
  const cleanupTimersRef = useRef(new Map<string, NodeJS.Timeout>());
  const usageCountRef = useRef(new Map<string, number>());
  const [sessions, setSessions] = useState<Set<string>>(new Set());
  // Version counter to trigger re-renders when sessions update
  const [sessionVersion, setSessionVersion] = useState(0);
  // Conversation IDs currently playing the title typing animation
  const [animatingTitleIds, setAnimatingTitleIds] = useState<Set<string>>(
    new Set(),
  );
  // Per-conversation timers that clear the animation, so they don't cancel each other
  const titleAnimationTimersRef = useRef(new Map<string, NodeJS.Timeout>());

  // Increment version when sessions change (triggers re-renders in consumers)
  const notifySessionUpdate = useCallback(() => {
    setSessionVersion((v) => v + 1);
  }, []);

  const markTitleAnimating = useCallback((conversationId: string) => {
    setAnimatingTitleIds((prev) => new Set(prev).add(conversationId));

    // Reset any in-flight timer for this conversation so the window restarts
    const existingTimer = titleAnimationTimersRef.current.get(conversationId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      titleAnimationTimersRef.current.delete(conversationId);
      setAnimatingTitleIds((prev) => {
        const next = new Set(prev);
        next.delete(conversationId);
        return next;
      });
    }, TITLE_ANIMATION_DURATION);

    titleAnimationTimersRef.current.set(conversationId, timer);
  }, []);

  const cancelCleanup = useCallback((conversationId: string) => {
    // Increment usage count
    usageCountRef.current.set(
      conversationId,
      (usageCountRef.current.get(conversationId) ?? 0) + 1,
    );

    // Cancel any pending cleanup timer
    const timer = cleanupTimersRef.current.get(conversationId);
    if (timer) {
      clearTimeout(timer);
      cleanupTimersRef.current.delete(conversationId);
    }
  }, []);

  // Schedule cleanup for inactive sessions
  const scheduleCleanup = useCallback((conversationId: string) => {
    // Decrement usage count
    const currentCount = usageCountRef.current.get(conversationId) ?? 0;
    const newCount = Math.max(0, currentCount - 1);
    usageCountRef.current.set(conversationId, newCount);

    // Only schedule cleanup if no more usages
    if (newCount > 0) return;

    // Clear existing timer
    const existingTimer = cleanupTimersRef.current.get(conversationId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule new cleanup
    const timer = setTimeout(() => {
      const session = sessionsRef.current.get(conversationId);
      if (session) {
        sessionsRef.current.delete(conversationId);
        initialMessagesRef.current.delete(conversationId);
        cleanupTimersRef.current.delete(conversationId);
        usageCountRef.current.delete(conversationId);
        setSessions((prev) => {
          const next = new Set(prev);
          next.delete(conversationId);
          return next;
        });
      }
    }, SESSION_CLEANUP_TIMEOUT);

    cleanupTimersRef.current.set(conversationId, timer);
  }, []);

  // Register a new session (creates the useChat hook instance)
  const registerSession = useCallback(
    ({
      conversationId,
      initialMessages,
    }: {
      conversationId: string;
      initialMessages?: UIMessage[];
    }) => {
      if (
        initialMessages &&
        !sessionsRef.current.has(conversationId) &&
        !initialMessagesRef.current.has(conversationId)
      ) {
        initialMessagesRef.current.set(conversationId, initialMessages);
      }

      setSessions((prev) => {
        if (prev.has(conversationId)) {
          return prev;
        }
        const next = new Set(prev);
        next.add(conversationId);
        return next;
      });
    },
    [],
  );

  // Get a session
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionVersion as dependency to make this reactive
  const getSession = useCallback(
    (conversationId: string) => {
      const session = sessionsRef.current.get(conversationId);
      return session;
    },
    [sessionVersion],
  );

  // Clear a session manually
  const clearSession = useCallback(
    (conversationId: string) => {
      sessionsRef.current.delete(conversationId);
      initialMessagesRef.current.delete(conversationId);
      usageCountRef.current.delete(conversationId);
      const timer = cleanupTimersRef.current.get(conversationId);
      if (timer) {
        clearTimeout(timer);
        cleanupTimersRef.current.delete(conversationId);
      }
      setSessions((prev) => {
        const next = new Set(prev);
        next.delete(conversationId);
        return next;
      });
      notifySessionUpdate();
    },
    [notifySessionUpdate],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Clear all timers
      for (const timer of cleanupTimersRef.current.values()) {
        clearTimeout(timer);
      }

      for (const timer of titleAnimationTimersRef.current.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  const value = useMemo(
    () => ({
      registerSession,
      getSession,
      clearSession,
      notifySessionUpdate,
      scheduleCleanup,
      cancelCleanup,
      animatingTitleIds,
      markTitleAnimating,
    }),
    [
      registerSession,
      getSession,
      clearSession,
      notifySessionUpdate,
      scheduleCleanup,
      cancelCleanup,
      animatingTitleIds,
      markTitleAnimating,
    ],
  );

  return (
    <ChatContext.Provider value={value}>
      {/* Render hidden session components for each active conversation */}
      {Array.from(sessions).map((conversationId) => (
        <ChatSessionHook
          key={conversationId}
          conversationId={conversationId}
          initialMessages={initialMessagesRef.current.get(conversationId) ?? []}
          sessionsRef={sessionsRef}
          notifySessionUpdate={notifySessionUpdate}
          markTitleAnimating={markTitleAnimating}
        />
      ))}
      {children}
    </ChatContext.Provider>
  );
}

function ChatSessionHook({
  conversationId,
  initialMessages,
  sessionsRef,
  notifySessionUpdate,
  markTitleAnimating,
}: {
  conversationId: string;
  initialMessages: UIMessage[];
  sessionsRef: React.MutableRefObject<Map<string, ChatSession>>;
  notifySessionUpdate: () => void;
  markTitleAnimating: (conversationId: string) => void;
}) {
  const queryClient = useQueryClient();
  const appName = useAppName();
  const [pendingCustomServerToolCall, setPendingCustomServerToolCall] =
    useState<{ toolCallId: string; toolName: string } | null>(null);
  const [pendingMcpElicitation, setPendingMcpElicitation] =
    useState<ChatMcpElicitationRequest | null>(null);
  const [optimisticToolCalls, setOptimisticToolCalls] = useState<
    Array<{
      toolCallId: string;
      toolName: string;
      input: unknown;
    }>
  >([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [contextTokensUsed, setContextTokensUsed] = useState<number | null>(
    null,
  );
  const [contextWindow, setContextWindow] =
    useState<ContextWindowBreakdown | null>(null);
  const [contextCompaction, setContextCompaction] =
    useState<ContextCompactionState>({
      isCompacting: false,
      trigger: null,
      lastCompaction: null,
    });
  const generateTitleMutation = useGenerateConversationTitle();
  const resolveMcpElicitationMutation = useResolveChatMcpElicitation();
  // Destructure the stable mutateAsync (not the whole mutation object, whose
  // identity changes every render) so regenerateUserMessage stays referentially
  // stable and doesn't retrigger the session-sync effect on every render.
  const { mutateAsync: updateChatMessageAsync } =
    useUpdateChatMessage(conversationId);
  // Track if title generation has been attempted for this conversation
  const titleGenerationAttemptedRef = useRef(false);
  // Track when swap_agent was called so we can auto-poke the new agent on finish
  // Stores the poke text to send, or null if no swap is pending
  const swapAgentPendingRef = useRef<string | null>(null);
  // Ref to hold sendMessage for use in onFinish callback
  const sendMessageRef = useRef<
    | ((
        message: Parameters<ReturnType<typeof useChat>["sendMessage"]>[0],
      ) => void)
    | null
  >(null);
  // useChat returns clearError, but onError is defined inside the useChat config
  // (before the hook returns), so reach it through a ref like sendMessageRef.
  const clearErrorRef = useRef<(() => void) | null>(null);
  // Auto-retry state for transient errors
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Set while auto-retrying a *structured* (backend-persisted) error, so a
  // successful retry can wipe the now-stale persisted error card the backend
  // never clears on its own.
  const recoveredPersistedErrorRef = useRef(false);
  const clearChatErrors = useClearChatErrors();
  // Monotonically counts onError invocations. The duplicate-run reattach uses
  // it to detect that nothing happened between calling resumeStream() and its
  // promise resolving — the "run already finished" case, where the reconnect
  // gets a 204 and the SDK early-returns without firing onFinish or onError.
  const errorSeqRef = useRef(0);
  // True while a transient failure is being auto-recovered (retry scheduled
  // or reattaching to the active run); suppresses the inline error flash.
  // The ref is the source of truth: it is written synchronously inside
  // onError, BEFORE the SDK's error state reaches the page, so the very
  // render that delivers the error already sees the suppression. The state
  // mirror exists only to trigger re-renders/session sync — a state-only
  // flag commits one render too late and the error card flashes for a frame.
  const recoveringRef = useRef(false);
  const [isRecoveringState, setIsRecoveringState] = useState(false);
  const setIsRecovering = useCallback((value: boolean) => {
    recoveringRef.current = value;
    setIsRecoveringState(value);
  }, []);
  // Snapshot of the rendered messages at the moment recovery started; shown
  // instead of the live list while recovery passes through its ugly
  // intermediate states (answer dropped by regenerate, replay restarting from
  // empty) so the streamed text never visibly blinks away.
  const frozenMessagesRef = useRef<UIMessage[]>([]);
  const lastUserMessageIdRef = useRef<string | null>(null);
  const previousMessagesRef = useRef<UIMessage[]>([]);

  const recordContextCompaction = useCallback(
    (compaction: ContextCompactionRecord) => {
      const { updateContextTokens = true, ...lastCompaction } = compaction;
      setContextCompaction({
        isCompacting: false,
        trigger: null,
        lastCompaction,
      });

      if (
        updateContextTokens &&
        typeof lastCompaction.compactedTokenEstimate === "number"
      ) {
        setContextTokensUsed(lastCompaction.compactedTokenEstimate);
      }
    },
    [],
  );

  // a dropped connection between compaction-start and compaction-finish would
  // otherwise leave the spinner stuck on; clear it on any stream end.
  const clearActiveContextCompaction = useCallback(() => {
    setContextCompaction((current) => ({
      ...current,
      isCompacting: false,
      trigger: null,
    }));
  }, []);

  // Track early UI data from data-tool-ui-start events (toolCallId → resource data)
  const [earlyToolUiStarts, setEarlyToolUiStarts] = useState<
    ChatSession["earlyToolUiStarts"]
  >({});
  const shouldResume = shouldResumeActiveRun(initialMessages);

  const {
    messages,
    sendMessage,
    regenerate,
    resumeStream,
    status,
    setMessages,
    stop,
    error,
    clearError,
    addToolResult,
    addToolApprovalResponse,
  } = useChat({
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      credentials: "include",
      headers: {
        [EXTERNAL_AGENT_ID_HEADER]: getChatExternalAgentId(appName),
      },
      prepareReconnectToStreamRequest: ({ id, headers, credentials }) => ({
        api: `/api/chat/conversations/${id}/active-run`,
        headers,
        credentials,
      }),
    }),

    experimental_throttle: 100,
    id: conversationId,
    onFinish: async ({ message, isAbort, isError }) => {
      setOptimisticToolCalls([]);
      setPendingMcpElicitation(null);
      clearActiveContextCompaction();
      // The stream concluded — any auto-recovery (retry/reattach) is over.
      // NOT on stream errors: the SDK fires onFinish from a finally block
      // right after onError, so clearing here would wipe the recovery flag
      // the error handler just set (and misroute the auto-retry's 409 to the
      // genuine-duplicate toast). Error outcomes are owned by onError: it
      // either keeps a recovery in flight or clears the flag for terminal
      // errors.
      if (!isError) {
        setIsRecovering(false);
        // A structured error we silently auto-retried just succeeded — clear the
        // stale persisted error card the backend leaves behind (it never clears it
        // on a new run). Reset the flag first so a re-entrant finish can't double-fire.
        if (recoveredPersistedErrorRef.current) {
          recoveredPersistedErrorRef.current = false;
          try {
            await clearChatErrors.mutateAsync({ id: conversationId });
          } catch (error) {
            console.error(
              "[ChatSession] Failed to clear stale chat error after retry",
              error,
            );
          }
        }
      }

      // When the user stops mid-tool-call, the assistant message is left with a
      // tool part that never produced output, which the UI renders as a
      // perpetually "running" tool. Drop those dangling parts so the live view
      // matches what the backend persists (and a reload would show).
      if (isAbort) {
        // The updater form runs against the SDK's live messages, not this
        // callback's (throttled, possibly stale) closure, so the most recently
        // streamed text is never rolled back.
        setMessages((current) => {
          const stripped = pruneEmptyTrailingAssistantMessage(
            stripDanglingToolCalls(current),
          );
          // restoreRenderableAssistantParts treats the shrink as a streaming
          // regression and would resurrect the stripped parts on the next
          // render; sync the ref so that comparison sees no regression.
          previousMessagesRef.current = stripped;
          return stripped;
        });
      }

      const conversationInvalidate = queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });

      const conversationsSidebarInvalidate = queryClient.invalidateQueries({
        queryKey: ["conversations"],
      });

      // After a swap_agent stop, poke the new agent so it responds.
      // The new /api/chat POST re-reads the conversation from DB and
      // loads the swapped agent's system prompt + tools.
      if (swapAgentPendingRef.current) {
        // Check if the swap tool errored — if so, poke with a "swap failed" message
        // instead of the normal swap poke, so the current agent can inform the user
        const swapToolErrored = hasSwapToolError(message, appName);
        const pokeText = swapToolErrored
          ? SWAP_AGENT_FAILED_POKE_TEXT
          : swapAgentPendingRef.current;
        swapAgentPendingRef.current = null;
        setTimeout(() => {
          sendMessageRef.current?.({
            role: "user",
            parts: [{ type: "text", text: pokeText }],
          });
        }, 100);
      }

      // Free early UI HTML blobs now that all tool calls have rendered.
      setEarlyToolUiStarts({});

      await Promise.all([
        conversationInvalidate,
        conversationsSidebarInvalidate,
      ]);

      // Auto-generate title after the first settled exchange if still untitled
      const cachedTitle = queryClient.getQueryData<{ title?: string | null }>([
        "conversation",
        conversationId,
      ])?.title;
      const firstUserText = getConversationDisplayTitle(null, stableMessages);

      const shouldGenerateTitle =
        !titleGenerationAttemptedRef.current &&
        (!cachedTitle || cachedTitle === firstUserText);

      if (shouldGenerateTitle) {
        titleGenerationAttemptedRef.current = true;
        generateTitleMutation.mutate(
          {
            id: conversationId,
            regenerate: cachedTitle === firstUserText,
          },
          {
            onSuccess: (data) => {
              if (data) {
                markTitleAnimating(conversationId);
              }
            },
          },
        );
      }
    },
    onError: (chatError) => {
      errorSeqRef.current += 1;
      setOptimisticToolCalls([]);
      clearActiveContextCompaction();
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });
      // Chat errors are persisted asynchronously by the backend after the stream
      // fails, so refetch once immediately and once shortly after that write.
      setTimeout(() => {
        queryClient.invalidateQueries({
          queryKey: ["conversation", conversationId],
        });
      }, 500);
      console.error("[ChatSession] Error occurred:", {
        conversationId,
        errorName: chatError.name,
        errorMessage: chatError.message,
        retryCount: retryCountRef.current,
      });

      if (isDuplicateActiveRunError(chatError)) {
        if (!recoveringRef.current) {
          // A 409 outside auto-recovery is a genuine concurrent submit (e.g.
          // a second tab racing this conversation): reattaching would
          // silently drop the message the user just typed, so keep the
          // honest guard instead.
          toast.error(
            "This conversation already has a response in progress. Stop it before sending another message.",
          );
          // Clear the SDK error so this benign guard does not also render as
          // a hard inline error panel; the toast is the only surfaced
          // feedback.
          clearErrorRef.current?.();
          setPendingMcpElicitation(null);
          return;
        }
        // The 409 was provoked by our own auto-recovery: the stream
        // connection was severed (LB cut, network blip) while the backend
        // kept generating, and the auto-retry below re-POSTed into the live
        // run. Reattach to it via the active-run replay endpoint instead of
        // dead-ending: the user sees the in-progress response (and the Stop
        // button) again. If the run finished in the meantime, the reconnect
        // returns 204 and is a no-op — the conversation refetch above
        // already shows the persisted outcome.
        //
        // Clear the restore-on-regression buffer first: the auto-retry's
        // regenerate() has already dropped the severed turn's partial
        // assistant message, but previousMessagesRef still holds it and would
        // keep resurrecting it while the replay rebuilds the same message id
        // from empty — two writers fighting over one message in an update
        // loop that crashes the page (React #185, "Maximum update depth").
        // Emptying the buffer makes this path state-equivalent to the
        // mount-time resume, which has always been safe; the replay re-streams
        // everything the buffer was protecting anyway. The frozen snapshot
        // (captured before clearing) keeps the text on screen meanwhile.
        if (previousMessagesRef.current.length > 0) {
          frozenMessagesRef.current = previousMessagesRef.current;
        }
        previousMessagesRef.current = [];
        setIsRecovering(true);
        const reattachErrorSeq = errorSeqRef.current;
        void resumeStream().then(() => {
          // If the run had already finished, reconnectToStream got a 204 and
          // the SDK resolved this promise WITHOUT firing onFinish or onError
          // (ai@6 makeRequest early-returns on a null reconnect stream) —
          // nothing else would clear the recovery flag, and a stuck flag
          // misroutes the next genuine concurrent submit's 409 into this
          // reattach path (silently dropping the typed message) and keeps the
          // frozen snapshot rendered. Detect that nothing happened while we
          // waited (recovery still flagged, no new error) and conclude the
          // recovery; the conversation refetch above already shows the
          // persisted outcome. A successful replay clears the flag in
          // onFinish; a failed replay re-enters onError (bumping the seq) and
          // owns the flag from there.
          if (
            recoveringRef.current &&
            errorSeqRef.current === reattachErrorSeq
          ) {
            setIsRecovering(false);
            // This reattach ends the recovery without an onFinish/onError, so
            // drop any pending "clear the persisted error on success" intent —
            // otherwise it leaks into a later unrelated success.
            recoveredPersistedErrorRef.current = false;
            // Drop the stale duplicate-run error so the SDK returns to
            // "ready" instead of idling in the suppressed error state.
            clearErrorRef.current?.();
          }
        });
        return;
      }

      // Auto-retry transient errors (network failures, server errors)
      // Do not retry if the error already happened this attempt cycle to avoid
      // hammering a quota-exhausted API.
      if (
        isRetryableError(chatError) &&
        retryCountRef.current < MAX_AUTO_RETRIES
      ) {
        retryCountRef.current++;
        // A structured error was persisted by the backend; a successful retry must
        // clear that stale card (onFinish). Unstructured client errors leave no row.
        recoveredPersistedErrorRef.current =
          parseStructuredChatError(chatError.message) !== null;
        console.info(
          `[ChatSession] Auto-retrying (${retryCountRef.current}/${MAX_AUTO_RETRIES})...`,
        );
        setIsRecovering(true);
        retryTimerRef.current = setTimeout(() => {
          // Capture the view and break the restore-on-regression chain at the
          // moment the rebuild starts (not earlier — previousMessagesRef is
          // rebuilt every render, so clearing it before regenerate() would
          // just re-establish). Without this, the restore logic resurrects
          // the dropped partial answer while the retried stream rebuilds the
          // message from empty — the update loop that crashes the page
          // (React #185). The frozen snapshot keeps the text on screen
          // instead.
          frozenMessagesRef.current = previousMessagesRef.current;
          previousMessagesRef.current = [];
          regenerate();
        }, AUTO_RETRY_DELAY_MS);
        return;
      }

      // Terminal: no recovery in flight — surface the error (and keep its
      // persisted card, so drop any pending "clear on successful retry" intent).
      recoveredPersistedErrorRef.current = false;
      setPendingMcpElicitation(null);
      setIsRecovering(false);
    },
    onToolCall: ({ toolCall }) => {
      const toolShortName = getCurrentArchestraToolShortName(
        toolCall.toolName,
        appName,
      );

      setOptimisticToolCalls((current) => {
        if (current.some((call) => call.toolCallId === toolCall.toolCallId)) {
          return current;
        }

        return [
          ...current,
          {
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: "args" in toolCall ? toolCall.args : undefined,
          },
        ];
      });

      if (
        toolShortName === TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_SHORT_NAME
      ) {
        setPendingCustomServerToolCall(toolCall);
      }

      // Detect swap_agent tool and flag for poke on finish.
      // The backend's stopWhen: hasToolCall(...) stops the agentic loop
      // after swap_agent executes, so the old agent won't continue.
      // onFinish then sends a poke to trigger the new agent.
      if (toolShortName === TOOL_SWAP_AGENT_SHORT_NAME) {
        const agentName = getSwapAgentName(toolCall);
        swapAgentPendingRef.current = makeSwapAgentPokeText(
          typeof agentName === "string" ? agentName : "another agent",
        );
        queryClient.invalidateQueries({
          queryKey: ["conversation", conversationId],
        });
      }

      if (toolShortName === TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME) {
        swapAgentPendingRef.current = SWAP_TO_DEFAULT_AGENT_POKE_TEXT;
        queryClient.invalidateQueries({
          queryKey: ["conversation", conversationId],
        });
      }

      // Agents created through chat tool calls bypass the normal frontend
      // create-agent mutations, so the cached useInternalAgents() list can stay
      // stale unless we invalidate it here. Without this, the prompt input's
      // agent selector may not reflect a newly created/swapped-to agent yet.
      if (toolShortName === TOOL_CREATE_AGENT_SHORT_NAME) {
        queryClient.invalidateQueries({ queryKey: ["agents"] });
      }

      // Detect artifact_write tool and invalidate conversation to fetch updated artifact
      if (toolShortName === TOOL_ARTIFACT_WRITE_SHORT_NAME) {
        // Small delay to ensure backend has saved the artifact
        setTimeout(() => {
          queryClient.invalidateQueries({
            queryKey: ["conversation", conversationId],
          });
        }, 500);
      }
    },
    onData: (dataPart) => {
      // Handle token usage data from the backend stream
      if (dataPart.type === "data-token-usage") {
        const usage = dataPart.data as TokenUsage;
        setTokenUsage(usage);
        // The indicator tracks context-window occupancy, which is the prompt
        // (input) size; totalTokens additionally folds in output and would
        // overstate how full the window is.
        const occupancy = usage.inputTokens ?? usage.totalTokens;
        if (typeof occupancy === "number") {
          setContextTokensUsed(occupancy);
        }
      }

      // Seed the indicator at turn start with the backend's estimate of the
      // outgoing prompt, on the same yardstick as auto-compaction. Per-step
      // data-token-usage events then refine it with the provider's real count.
      // Also reset the breakdown: a new estimate means a new request is being
      // assembled, so the previous breakdown is stale until the new one arrives.
      if (dataPart.type === "data-context-window-estimate") {
        const data = dataPart.data as ContextWindowEstimate;
        if (typeof data.estimatedTokens === "number") {
          setContextTokensUsed(data.estimatedTokens);
          setContextWindow(null);
        }
      }

      // Per-category breakdown of the assembled request, powering the Context
      // Window Visualizer panel. Emitted once per turn after assembly.
      if (dataPart.type === CONTEXT_WINDOW_BREAKDOWN_EVENT) {
        const parsed = ContextWindowBreakdownSchema.safeParse(dataPart.data);
        if (parsed.success) {
          setContextWindow(parsed.data);
        }
        // Malformed payload: silently drop — never throw, never surface to the user.
      }

      if (dataPart.type === "data-context-compaction-start") {
        const data = dataPart.data as { trigger?: "auto" | "manual" };
        setContextCompaction((current) => ({
          ...current,
          isCompacting: true,
          trigger: data.trigger ?? "auto",
        }));
      }

      if (dataPart.type === "data-context-compaction-finish") {
        const data = dataPart.data as {
          trigger?: "auto" | "manual";
          compactionId?: string;
          originalTokenEstimate?: number;
          compactedTokenEstimate?: number;
        };
        recordContextCompaction(data);
        queryClient.invalidateQueries({
          queryKey: ["conversation", conversationId],
        });
      }

      // Handle data-tool-ui-start: backend emits this when a tool call starts streaming,
      // so the frontend can render the MCP App container immediately (before tool finishes)
      const customData = dataPart as unknown as {
        type?: string;
        data?: unknown;
      };
      if (customData.type === "data-tool-ui-start") {
        const { toolCallId, toolName, uiResourceUri, html, csp, permissions } =
          (customData.data ??
            {}) as ChatSession["earlyToolUiStarts"][string] & {
            toolCallId?: string;
            toolName?: string;
          };
        if (toolCallId && uiResourceUri) {
          setEarlyToolUiStarts((prev) => ({
            ...prev,
            [toolCallId]: { uiResourceUri, html, csp, permissions, toolName },
          }));
        }
      }

      if (customData.type === "data-mcp-elicitation") {
        const data = customData.data as ChatMcpElicitationRequest | undefined;
        if (data?.id && data.conversationId === conversationId) {
          setPendingMcpElicitation(data);
        }
      }
    },
    sendAutomaticallyWhen: ({ messages: msgs }) => {
      // Don't auto-resubmit after swap_agent — the poke in onFinish handles it
      if (swapAgentPendingRef.current) return false;
      return lastAssistantMessageIsCompleteWithApprovalResponses({
        messages: msgs,
      });
    },
  } as Parameters<typeof useChat>[0]);

  const resumeAttemptedRef = useRef(false);
  useEffect(() => {
    if (!shouldResume || resumeAttemptedRef.current) {
      return;
    }

    resumeAttemptedRef.current = true;
    void resumeStream();
  }, [resumeStream, shouldResume]);

  const messagesWithRestoredAssistantParts = restoreRenderableAssistantParts({
    previousMessages: previousMessagesRef.current,
    nextMessages: messages,
  });
  previousMessagesRef.current = messagesWithRestoredAssistantParts;

  // Keep sendMessageRef up-to-date for onFinish callback
  sendMessageRef.current = sendMessage;
  // Keep clearErrorRef up-to-date for the duplicate-run branch in onError
  clearErrorRef.current = clearError;

  const stableMessages = messagesWithRestoredAssistantParts;

  // While auto-recovery passes through its intermediate states (partial
  // answer dropped by regenerate, replay restarting from empty), keep showing
  // the snapshot captured when recovery started so streamed text never blinks
  // away. The replay delivers its whole backlog in the first batch, so by the
  // time the live list has renderable assistant content again it is at least
  // as long as the frozen view.
  const displayedMessages = shouldFreezeChatMessages({
    isRecovering: recoveringRef.current,
    liveMessages: stableMessages,
    frozenMessages: frozenMessagesRef.current,
  })
    ? frozenMessagesRef.current
    : stableMessages;

  // Reset retry counter only when the user sends a genuinely new message.
  // We track the last user message ID to avoid resetting during regenerate(),
  // which manipulates the messages array without a new user message.
  const lastStableUserMessage = [...stableMessages]
    .reverse()
    .find((m) => m.role === "user");
  if (
    lastStableUserMessage &&
    lastStableUserMessage.id !== lastUserMessageIdRef.current
  ) {
    lastUserMessageIdRef.current = lastStableUserMessage.id;
    retryCountRef.current = 0;
    // A new turn: any pending "clear the prior turn's persisted error on a
    // successful retry" intent no longer applies to this turn.
    recoveredPersistedErrorRef.current = false;
  }

  useEffect(() => {
    if (optimisticToolCalls.length === 0) {
      return;
    }

    setOptimisticToolCalls((current) =>
      filterOptimisticToolCalls(stableMessages, current),
    );
  }, [stableMessages, optimisticToolCalls.length]);

  // Save the user message's text, then re-run the assistant turn from it.
  const regenerateUserMessage = useCallback(
    async ({
      messageId,
      partIndex,
      text,
    }: {
      messageId: string;
      partIndex: number;
      text: string;
    }) => {
      // Snapshot the live thread before touching any state — it is the only
      // place that knows the live↔saved id mapping for in-session messages
      // (metadata.persistedMessageId, stamped by mergePersistedMessageMetadata).
      const liveMessages = previousMessagesRef.current;

      // Persist the (possibly edited) text and get the saved thread back, which
      // carries each message under its DB id.
      const data = await updateChatMessageAsync({ messageId, partIndex, text });
      const canonical = data?.messages as UIMessage[] | undefined;
      // In-session messages keep their AI SDK nanoid as the live id while the
      // saved thread keys them by DB UUID, so a plain id lookup misses them.
      // Resolve through metadata.persistedMessageId too — otherwise the first
      // edit before a reload falls into the regenerate-in-place path below and
      // re-sends the pre-edit text, making the model answer the old prompt.
      const anchorId = resolveCanonicalMessageId({
        messageId,
        liveMessages,
        canonicalMessages: canonical,
      });

      // Break the restore-on-regression chain before regenerating, like the
      // auto-retry and 409-reattach paths do: regenerate() rebuilds the edited
      // turn's assistant message from empty, and a buffer still holding the
      // pre-edit answer would keep resurrecting it while the new stream writes
      // the same message id — two writers fighting over one message in an
      // update loop that crashes the page (React #185, "Maximum update
      // depth"). The pre-edit answer is meant to disappear here, so no frozen
      // snapshot is taken.
      previousMessagesRef.current = [];

      if (canonical && anchorId) {
        // Normal path: the message is persisted. Sync to the saved thread and
        // regenerate from it. The server replaces the turn atomically.
        setMessages(canonical);
        void regenerate({ messageId: anchorId });
        return;
      }

      // --- swap_agent support (safe to delete this block) ---
      // After switching agents the target message can still be in-session: its
      // id is an AI SDK nanoid, so it isn't found in the saved thread above.
      // Regenerate in place using the live id (the backend matches it to the
      // stored row by content id). Apply the edited text to the live message
      // first: regenerate() re-sends the live thread, which otherwise still
      // holds the pre-edit text.
      setMessages((current) =>
        applyTextEditToMessages({
          messages: current,
          messageId,
          partIndex,
          text,
        }),
      );
      void regenerate({ messageId });
    },
    [updateChatMessageAsync, setMessages, regenerate],
  );

  // Always keep the session ref up-to-date with the latest values (including
  // function references from useChat which change every render). This is a ref
  // update only — no state changes, no re-renders.
  const sessionRef = useRef<ChatSession>(null as unknown as ChatSession);
  sessionRef.current = {
    conversationId,
    messages: displayedMessages,
    sendMessage,
    regenerateUserMessage,
    stop,
    status,
    error,
    setMessages,
    addToolResult,
    addToolApprovalResponse,
    pendingCustomServerToolCall,
    pendingMcpElicitation,
    // Computed, not stored: the page paints the SDK error before onError has
    // run (so no flag set inside onError can suppress the first frame), and
    // consumers read the session from a map refreshed an effect-cycle later.
    // Instead, derive "this error will be auto-recovered" synchronously from
    // the same predicates onError uses — a pure function of the error and the
    // retry budget, correct at any render including the very first one.
    // recoveringRef keeps it true after onError consumed the error (retry
    // timer pending / reattach in flight) and onFinish/terminal paths clear it.
    get isRecovering() {
      if (recoveringRef.current) {
        return true;
      }
      if (!error) {
        return false;
      }
      return (
        isDuplicateActiveRunError(error) ||
        (isRetryableError(error) && retryCountRef.current < MAX_AUTO_RETRIES)
      );
    },
    optimisticToolCalls,
    setPendingCustomServerToolCall,
    tokenUsage,
    contextTokensUsed,
    contextWindow,
    contextCompaction,
    recordContextCompaction,
    earlyToolUiStarts,
  };

  // Sync to the shared sessions map and notify consumers.
  // All chat state values are listed as deps so the effect fires when any value
  // changes, even though we read them through the ref for the latest snapshot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — deps trigger the sync, ref provides the snapshot
  useEffect(() => {
    sessionsRef.current.set(conversationId, sessionRef.current);
    notifySessionUpdate();
  }, [
    conversationId,
    stableMessages,
    sendMessage,
    regenerateUserMessage,
    stop,
    status,
    error,
    setMessages,
    addToolResult,
    addToolApprovalResponse,
    pendingCustomServerToolCall,
    pendingMcpElicitation,
    isRecoveringState,
    optimisticToolCalls,
    tokenUsage,
    contextTokensUsed,
    contextWindow,
    contextCompaction,
    recordContextCompaction,
    earlyToolUiStarts,
    sessionsRef,
    notifySessionUpdate,
  ]);

  return (
    <McpElicitationDialog
      request={pendingMcpElicitation}
      isSubmitting={resolveMcpElicitationMutation.isPending}
      onRespond={async ({ id, action, content }) => {
        const result = await resolveMcpElicitationMutation.mutateAsync({
          id,
          conversationId,
          action,
          content,
        });
        if (result) {
          setPendingMcpElicitation(null);
        }
      }}
    />
  );
}

function getSwapAgentName(toolCall: unknown): string | null {
  if (typeof toolCall !== "object" || toolCall === null) {
    return null;
  }

  const args =
    "args" in toolCall && typeof toolCall.args === "object"
      ? toolCall.args
      : undefined;

  return extractSwapTargetAgentName({
    input: args,
  });
}

function hasSwapToolError(message: UIMessage, appName: string): boolean {
  return (message.parts ?? []).some((part) => {
    if (typeof part !== "object" || !part) return false;
    const toolName = getRenderedToolName(part);
    if (!toolName) return false;

    const shortName = getSwapToolShortName({
      toolName,
      getToolShortName: (fullToolName): ArchestraToolShortName | null =>
        getCurrentArchestraToolShortName(
          fullToolName,
          appName,
        ) as ArchestraToolShortName | null,
    });
    if (
      shortName !== TOOL_SWAP_AGENT_SHORT_NAME &&
      shortName !== TOOL_SWAP_TO_DEFAULT_AGENT_SHORT_NAME
    ) {
      return false;
    }

    return hasSwapToolErrorInPart(part);
  });
}

function getCurrentArchestraToolShortName(
  toolName: string,
  appName: string,
): string | null {
  return getArchestraToolShortName(toolName, {
    appName,
    fullWhiteLabeling: appConfig.enterpriseFeatures.fullWhiteLabeling,
    includeDefaultPrefix: true,
  });
}

export function useGlobalChat() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useGlobalChat must be used within ChatProvider");
  }
  return context;
}

export function useChatSession(params: {
  conversationId: string | undefined;
  initialMessages?: UIMessage[];
  enabled?: boolean;
}) {
  const { conversationId, initialMessages, enabled = true } = params;
  const { registerSession, getSession, scheduleCleanup, cancelCleanup } =
    useGlobalChat();

  useEffect(() => {
    if (!conversationId || !enabled) return;

    registerSession({ conversationId, initialMessages });
    cancelCleanup(conversationId);

    return () => {
      scheduleCleanup(conversationId);
    };
  }, [
    cancelCleanup,
    conversationId,
    enabled,
    initialMessages,
    registerSession,
    scheduleCleanup,
  ]);

  return conversationId ? getSession(conversationId) : null;
}
