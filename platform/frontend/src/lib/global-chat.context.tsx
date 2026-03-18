"use client";

import { type UIMessage, useChat } from "@ai-sdk/react";
import {
  EXTERNAL_AGENT_ID_HEADER,
  isChatErrorResponse,
  makeSwapAgentPokeText,
  SWAP_AGENT_FAILED_POKE_TEXT,
  SWAP_TO_DEFAULT_AGENT_POKE_TEXT,
  TOOL_ARTIFACT_WRITE_FULL_NAME,
  TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME,
  TOOL_SWAP_AGENT_FULL_NAME,
  TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME,
  type TokenUsage,
} from "@shared";
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
import { filterOptimisticToolCalls } from "@/components/chat/chat-messages.utils";
import { useGenerateConversationTitle } from "@/lib/chat.query";

const SESSION_CLEANUP_TIMEOUT = 10 * 60 * 1000; // 10 min
const MAX_AUTO_RETRIES = 2;
const AUTO_RETRY_DELAY_MS = 1500;

/** Network-level errors that never reach the backend */
const RETRYABLE_CLIENT_ERRORS = [
  "Failed to fetch",
  "NetworkError",
  "No output generated",
  "network",
];

function isRetryableError(error: Error): boolean {
  const msg = error.message;
  // Check client-side patterns
  if (RETRYABLE_CLIENT_ERRORS.some((p) => msg.includes(p))) return true;
  // Check structured backend error
  try {
    const parsed = JSON.parse(msg);
    if (isChatErrorResponse(parsed)) return parsed.isRetryable;
  } catch {
    // not JSON
  }
  return false;
}

interface ChatSession {
  conversationId: string;
  messages: UIMessage[];
  sendMessage: (
    message: Parameters<ReturnType<typeof useChat>["sendMessage"]>[0],
  ) => void;
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
}

interface ChatContextValue {
  registerSession: (conversationId: string) => void;
  getSession: (conversationId: string) => ChatSession | undefined;
  clearSession: (conversationId: string) => void;
  notifySessionUpdate: () => void;
  scheduleCleanup: (conversationId: string) => void;
  cancelCleanup: (conversationId: string) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const sessionsRef = useRef(new Map<string, ChatSession>());
  const cleanupTimersRef = useRef(new Map<string, NodeJS.Timeout>());
  const usageCountRef = useRef(new Map<string, number>());
  const [sessions, setSessions] = useState<Set<string>>(new Set());
  // Version counter to trigger re-renders when sessions update
  const [sessionVersion, setSessionVersion] = useState(0);

  // Increment version when sessions change (triggers re-renders in consumers)
  const notifySessionUpdate = useCallback(() => {
    setSessionVersion((v) => v + 1);
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
  const registerSession = useCallback((conversationId: string) => {
    setSessions((prev) => {
      if (prev.has(conversationId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(conversationId);
      return next;
    });
  }, []);

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
    }),
    [
      registerSession,
      getSession,
      clearSession,
      notifySessionUpdate,
      scheduleCleanup,
      cancelCleanup,
    ],
  );

  return (
    <ChatContext.Provider value={value}>
      {/* Render hidden session components for each active conversation */}
      {Array.from(sessions).map((conversationId) => (
        <ChatSessionHook
          key={conversationId}
          conversationId={conversationId}
          sessionsRef={sessionsRef}
          notifySessionUpdate={notifySessionUpdate}
        />
      ))}
      {children}
    </ChatContext.Provider>
  );
}

function ChatSessionHook({
  conversationId,
  sessionsRef,
  notifySessionUpdate,
}: {
  conversationId: string;
  sessionsRef: React.MutableRefObject<Map<string, ChatSession>>;
  notifySessionUpdate: () => void;
}) {
  const queryClient = useQueryClient();
  const [pendingCustomServerToolCall, setPendingCustomServerToolCall] =
    useState<{ toolCallId: string; toolName: string } | null>(null);
  const [optimisticToolCalls, setOptimisticToolCalls] = useState<
    Array<{
      toolCallId: string;
      toolName: string;
      input: unknown;
    }>
  >([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const generateTitleMutation = useGenerateConversationTitle();
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
  // Auto-retry state for transient errors
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const prevMessagesLenRef = useRef(0);

  const {
    messages,
    sendMessage,
    regenerate,
    status,
    setMessages,
    stop,
    error,
    addToolResult,
    addToolApprovalResponse,
  } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      credentials: "include",
      headers: {
        [EXTERNAL_AGENT_ID_HEADER]: "Archestra Chat",
      },
    }),
    id: conversationId,
    onFinish: ({ message }) => {
      setOptimisticToolCalls([]);
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });

      // After a swap_agent stop, poke the new agent so it responds.
      // The new /api/chat POST re-reads the conversation from DB and
      // loads the swapped agent's system prompt + tools.
      if (swapAgentPendingRef.current) {
        // Check if the swap tool errored — if so, poke with a "swap failed" message
        // instead of the normal swap poke, so the current agent can inform the user
        const swapToolErrored = hasSwapToolError(message);
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

      // Attempt to generate title after first assistant response
      // This will be checked when messages update in the effect below
    },
    onError: (chatError) => {
      setOptimisticToolCalls([]);
      console.error("[ChatSession] Error occurred:", {
        conversationId,
        error: chatError,
        message: chatError.message,
        retryCount: retryCountRef.current,
      });

      // Auto-retry transient errors (network failures, server errors)
      if (
        isRetryableError(chatError) &&
        retryCountRef.current < MAX_AUTO_RETRIES
      ) {
        retryCountRef.current++;
        console.info(
          `[ChatSession] Auto-retrying (${retryCountRef.current}/${MAX_AUTO_RETRIES})...`,
        );
        retryTimerRef.current = setTimeout(() => {
          regenerate();
        }, AUTO_RETRY_DELAY_MS);
      }
    },
    onToolCall: ({ toolCall }) => {
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
        toolCall.toolName ===
        TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME
      ) {
        setPendingCustomServerToolCall(toolCall);
      }

      // Detect swap_agent tool and flag for poke on finish.
      // The backend's stopWhen: hasToolCall(...) stops the agentic loop
      // after swap_agent executes, so the old agent won't continue.
      // onFinish then sends a poke to trigger the new agent.
      if (toolCall.toolName === TOOL_SWAP_AGENT_FULL_NAME) {
        const agentName = (
          toolCall as unknown as { args?: Record<string, unknown> }
        ).args?.agent_name;
        swapAgentPendingRef.current = makeSwapAgentPokeText(
          typeof agentName === "string" ? agentName : "another agent",
        );
        queryClient.invalidateQueries({
          queryKey: ["conversation", conversationId],
        });
      }

      if (toolCall.toolName === TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME) {
        swapAgentPendingRef.current = SWAP_TO_DEFAULT_AGENT_POKE_TEXT;
        queryClient.invalidateQueries({
          queryKey: ["conversation", conversationId],
        });
      }

      // Detect artifact_write tool and invalidate conversation to fetch updated artifact
      if (toolCall.toolName === TOOL_ARTIFACT_WRITE_FULL_NAME) {
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

  // Keep sendMessageRef up-to-date for onFinish callback
  sendMessageRef.current = sendMessage;

  // Reset retry counter when a new user message is sent (messages array grows).
  // regenerate() doesn't add messages, so this won't reset during retries.
  if (messages.length > prevMessagesLenRef.current) {
    retryCountRef.current = 0;
  }
  prevMessagesLenRef.current = messages.length;

  useEffect(() => {
    if (optimisticToolCalls.length === 0) {
      return;
    }

    setOptimisticToolCalls((current) =>
      filterOptimisticToolCalls(messages, current),
    );
  }, [messages, optimisticToolCalls.length]);

  // Auto-generate title after first assistant response
  useEffect(() => {
    // Skip if already attempted or currently generating
    if (
      titleGenerationAttemptedRef.current ||
      generateTitleMutation.isPending
    ) {
      return;
    }

    // Check if we have at least one user message and one assistant message
    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    // Only generate title after first exchange (1 user + 1 assistant message)
    // and when status is ready (not still streaming)
    if (
      userMessages.length === 1 &&
      assistantMessages.length === 1 &&
      status === "ready"
    ) {
      // Check if assistant message has actual text content (not just tool calls)
      const assistantHasText = assistantMessages[0].parts.some(
        (part) => part.type === "text" && "text" in part && part.text,
      );

      if (assistantHasText) {
        titleGenerationAttemptedRef.current = true;
        generateTitleMutation.mutate({ id: conversationId });
      }
    }
  }, [messages, status, conversationId, generateTitleMutation]);

  // Always keep the session ref up-to-date with the latest values (including
  // function references from useChat which change every render). This is a ref
  // update only — no state changes, no re-renders.
  const sessionRef = useRef<ChatSession>(null as unknown as ChatSession);
  sessionRef.current = {
    conversationId,
    messages,
    sendMessage,
    stop,
    status,
    error,
    setMessages,
    addToolResult,
    addToolApprovalResponse,
    pendingCustomServerToolCall,
    optimisticToolCalls,
    setPendingCustomServerToolCall,
    tokenUsage,
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
    messages,
    sendMessage,
    stop,
    status,
    error,
    setMessages,
    addToolResult,
    addToolApprovalResponse,
    pendingCustomServerToolCall,
    optimisticToolCalls,
    tokenUsage,
    sessionsRef,
    notifySessionUpdate,
  ]);

  return null;
}

const SWAP_TOOL_TYPES = new Set([
  TOOL_SWAP_AGENT_FULL_NAME,
  `tool-${TOOL_SWAP_AGENT_FULL_NAME}`,
  TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME,
  `tool-${TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME}`,
]);

function hasSwapToolError(message: UIMessage): boolean {
  return (message.parts ?? []).some((part) => {
    if (typeof part !== "object" || !part || !("type" in part)) return false;
    const type = part.type as string;
    if (!SWAP_TOOL_TYPES.has(type)) return false;
    const toolPart = part as Record<string, unknown>;
    if (toolPart.errorText) return true;
    if (typeof toolPart.output === "string") {
      try {
        const parsed = JSON.parse(toolPart.output as string);
        if (typeof parsed?.error === "string") return true;
      } catch {
        // ignore
      }
    }
    return false;
  });
}

export function useGlobalChat() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useGlobalChat must be used within ChatProvider");
  }
  return context;
}

export function useChatSession(conversationId: string | undefined) {
  const { registerSession, getSession, scheduleCleanup, cancelCleanup } =
    useGlobalChat();

  useEffect(() => {
    if (!conversationId) return;

    registerSession(conversationId);
    cancelCleanup(conversationId);

    return () => {
      scheduleCleanup(conversationId);
    };
  }, [conversationId, registerSession, scheduleCleanup, cancelCleanup]);

  return conversationId ? getSession(conversationId) : null;
}
