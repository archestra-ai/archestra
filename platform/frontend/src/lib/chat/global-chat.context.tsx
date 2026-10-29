"use client";

import type { UIMessage, useChat } from "@ai-sdk/react";
import type {
  ContextWindowBreakdown,
  McpTaskPartData,
  TokenUsage,
} from "@archestra/shared";
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChatMcpElicitationRequest,
  ElicitationResponse,
} from "@/components/chat/mcp-elicitation-fields";
import { appInteractive } from "@/lib/app-interactive";
import { useConversationUpdatedCacheSync } from "@/lib/chat/chat.query";

const SESSION_CLEANUP_TIMEOUT = 10 * 60 * 1000; // 10 min

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

export type ContextCompactionRecord = NonNullable<
  ContextCompactionState["lastCompaction"]
> & {
  updateContextTokens?: boolean;
};

export interface ChatSession {
  conversationId: string;
  messages: UIMessage[];
  /** Monotonic signal advanced by every event received from the stream. */
  transportActivitySequence: number;
  /** Monotonic signal advanced only when the assistant response progresses. */
  responseProgressSequence: number;
  /** True once a stalled turn's reattaches are used up; the stall notice shows only then. */
  stallRecoveryExhausted: boolean;
  sendMessage: (
    message: Parameters<ReturnType<typeof useChat>["sendMessage"]>[0],
  ) => void;
  /**
   * Send a text message from a tool card (credential cards, MCP Apps). While
   * the conversation is busy — a turn in flight, a compaction, or messages
   * already waiting — it joins the queue instead, so it is never lost to a
   * racing send.
   */
  sendOrQueueText: (text: string) => void;
  /** Re-run the assistant turn for a user message, optionally with edited text. */
  regenerateUserMessage: (args: {
    messageId: string;
    partIndex: number;
    text: string;
  }) => Promise<void>;
  stop: (options?: {
    preserveQueuedMessages?: boolean;
    interruptQueued?: boolean;
    stopServer?: () => Promise<unknown>;
  }) => void;
  status: "ready" | "submitted" | "streaming" | "error";
  error: Error | undefined;
  setMessages: ReturnType<typeof useChat>["setMessages"];
  addToolResult: ReturnType<typeof useChat>["addToolResult"];
  addToolApprovalResponse: ReturnType<
    typeof useChat
  >["addToolApprovalResponse"];
  /**
   * Pending questions in this conversation, oldest first.
   * Multiple-choice questions render together in one inline card with tabs.
   * Other requests open the modal dialog form one at a time.
   */
  pendingMcpElicitations: ChatMcpElicitationRequest[];
  resolveMcpElicitation: (response: ElicitationResponse) => Promise<boolean>;
  /**
   * Background MCP tasks for the running turn, keyed by task id.
   *
   * Held as state rather than read off message parts because the backend
   * streams them transiently: a non-transient data part written mid-stream
   * makes the AI SDK open a second assistant message, which renders the whole
   * tool group twice for as long as the call runs. History still comes from
   * the persisted parts the backend splices in at the end of the turn.
   */
  mcpTasks: Record<string, McpTaskPartData>;
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
  /** Token usage for the current/last response */
  tokenUsage: TokenUsage | null;
  contextTokensUsed: number | null;
  /** Per-category breakdown of the assembled request for the current turn */
  contextWindow: ContextWindowBreakdown | null;
  contextCompaction: ContextCompactionState;
  recordContextCompaction: (compaction: ContextCompactionRecord) => void;
  /**
   * Bracket a manual (REST) compaction, which runs outside the stream and so
   * has no compaction-start/finish data parts to flip `contextCompaction`.
   * Between the two calls the conversation counts as compacting, which keeps
   * composer submits queueing and parks the queued-message drain. Call `end`
   * on every exit path — a missed one strands the queue.
   */
  beginManualContextCompaction: () => void;
  endManualContextCompaction: () => void;
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
  /** Latest session snapshot. Not reactive: render through useChatSessionSnapshot. */
  getSession: (conversationId: string) => ChatSession | undefined;
  clearSession: (conversationId: string) => void;
  /** Subscribe to session snapshot changes (fires on every streamed chunk). */
  subscribeSessionUpdates: (listener: () => void) => () => void;
  scheduleCleanup: (conversationId: string) => void;
  cancelCleanup: (conversationId: string) => void;
  /** Conversation IDs whose session is submitting or streaming. Changes only on status transitions. */
  generatingConversationIds: ReadonlySet<string>;
  /** Conversation IDs whose title should currently play the typing animation */
  animatingTitleIds: Set<string>;
  /** Mark a conversation's title to play the typing animation (auto-clears after a few seconds) */
  markTitleAnimating: (conversationId: string) => void;
}

/** How long a freshly generated title keeps playing the typing animation */
const TITLE_ANIMATION_DURATION = 3000;

const ChatContext = createContext<ChatContextValue | null>(null);

/**
 * The AI SDK session machinery, out of the first load. It is fetched on the
 * first idle callback after the composer hydrates (preloadChatSessionHook),
 * or as soon as a conversation registers a session, whichever is first. A
 * send before it has loaded is queued and drained once the session exists
 * (see the page's submit handler).
 */
const loadChatSessionHook = () => import("./chat-session-hook");
const ChatSessionHook = lazy(loadChatSessionHook);
if (typeof window !== "undefined") {
  void appInteractive.whenIdle().then(loadChatSessionHook);
}

export function ChatProvider({ children }: { children: ReactNode }) {
  // Refresh sidebar unread indicators when the server pushes a message-landed
  // event (covers turns that finish after the client navigated away).
  useConversationUpdatedCacheSync();

  const sessionsRef = useRef(new Map<string, ChatSession>());
  const initialMessagesRef = useRef(new Map<string, UIMessage[]>());
  const cleanupTimersRef = useRef(new Map<string, NodeJS.Timeout>());
  const usageCountRef = useRef(new Map<string, number>());
  const [sessions, setSessions] = useState<Set<string>>(new Set());
  const sessionUpdateListenersRef = useRef(new Set<() => void>());
  const [generatingConversationIds, setGeneratingConversationIds] = useState<
    ReadonlySet<string>
  >(new Set());
  // Conversation IDs currently playing the title typing animation
  const [animatingTitleIds, setAnimatingTitleIds] = useState<Set<string>>(
    new Set(),
  );
  // Per-conversation timers that clear the animation, so they don't cancel each other
  const titleAnimationTimersRef = useRef(new Map<string, NodeJS.Timeout>());

  const subscribeSessionUpdates = useCallback((listener: () => void) => {
    sessionUpdateListenersRef.current.add(listener);
    return () => {
      sessionUpdateListenersRef.current.delete(listener);
    };
  }, []);

  // Session snapshots change on every streamed chunk. Only subscribers re-render
  // for those; the context value changes just when a conversation starts or
  // stops generating, so global consumers such as the sidebar stay put.
  const notifySessionUpdate = useCallback(
    (update?: { conversationId: string; status: ChatSession["status"] }) => {
      for (const listener of sessionUpdateListenersRef.current) {
        listener();
      }
      if (update) {
        setConversationGenerating(
          setGeneratingConversationIds,
          update.conversationId,
          update.status === "submitted" || update.status === "streaming",
        );
      }
    },
    [],
  );

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
        setConversationGenerating(
          setGeneratingConversationIds,
          conversationId,
          false,
        );
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

  const getSession = useCallback(
    (conversationId: string) => sessionsRef.current.get(conversationId),
    [],
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
      setConversationGenerating(
        setGeneratingConversationIds,
        conversationId,
        false,
      );
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
      subscribeSessionUpdates,
      scheduleCleanup,
      cancelCleanup,
      generatingConversationIds,
      animatingTitleIds,
      markTitleAnimating,
    }),
    [
      registerSession,
      getSession,
      clearSession,
      subscribeSessionUpdates,
      scheduleCleanup,
      cancelCleanup,
      generatingConversationIds,
      animatingTitleIds,
      markTitleAnimating,
    ],
  );

  return (
    <ChatContext.Provider value={value}>
      {/* Render hidden session components for each active conversation */}
      <Suspense fallback={null}>
        {Array.from(sessions).map((conversationId) => (
          <ChatSessionHook
            key={conversationId}
            conversationId={conversationId}
            initialMessages={
              initialMessagesRef.current.get(conversationId) ?? []
            }
            sessionsRef={sessionsRef}
            notifySessionUpdate={notifySessionUpdate}
            markTitleAnimating={markTitleAnimating}
          />
        ))}
      </Suspense>
      {children}
    </ChatContext.Provider>
  );
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
  const { registerSession, scheduleCleanup, cancelCleanup } = useGlobalChat();
  const session = useChatSessionSnapshot(conversationId);

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

  return session;
}

/**
 * The latest snapshot of a conversation's chat session, re-rendering as it
 * changes. Snapshots change on every streamed chunk, so those re-renders run as
 * transitions: a keystroke in the composer interrupts an in-progress transcript
 * render instead of queueing behind it.
 */
export function useChatSessionSnapshot(
  conversationId: string | undefined,
): ChatSession | null {
  const { getSession, subscribeSessionUpdates } = useGlobalChat();
  // Held in state, never read from the session map during render. A render
  // that bails out — an unrelated urgent update landing while this transition
  // is still pending — keeps the hook values it computed but drops its
  // effects. Reading the map there would record the new session in effect
  // dependencies without running those effects, so an effect keyed on the
  // session's stable functions (sendMessage, setMessages) or an unchanged
  // status would never fire: a just-created chat would never send its
  // opening message.
  const [snapshot, setSnapshot] = useState(() => ({
    conversationId,
    session: conversationId ? (getSession(conversationId) ?? null) : null,
  }));

  useEffect(() => {
    const sync = () => {
      const session = conversationId
        ? (getSession(conversationId) ?? null)
        : null;
      setSnapshot((current) =>
        current.conversationId === conversationId && current.session === session
          ? current
          : { conversationId, session },
      );
    };
    // The session may have been registered between the first render and
    // this subscription.
    sync();
    return subscribeSessionUpdates(() => {
      startTransition(sync);
    });
  }, [conversationId, getSession, subscribeSessionUpdates]);

  return snapshot.conversationId === conversationId ? snapshot.session : null;
}

function setConversationGenerating(
  setIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
  conversationId: string,
  generating: boolean,
) {
  setIds((prev) => {
    if (prev.has(conversationId) === generating) return prev;
    const next = new Set(prev);
    if (generating) {
      next.add(conversationId);
    } else {
      next.delete(conversationId);
    }
    return next;
  });
}
