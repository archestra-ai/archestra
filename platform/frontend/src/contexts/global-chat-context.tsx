"use client";

import { type UIMessage, useChat } from "@ai-sdk/react";
import {
  EXTERNAL_AGENT_ID_HEADER,
  TOOL_ARTIFACT_WRITE_FULL_NAME,
  TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME,
  type TokenUsage,
} from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { DefaultChatTransport } from "ai";
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
import { useGenerateConversationTitle } from "@/lib/chat.query";

const SESSION_CLEANUP_TIMEOUT = 10 * 60 * 1000; // 10 min

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
  pendingCustomServerToolCall: {
    toolCallId: string;
    toolName: string;
  } | null;
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
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const generateTitleMutation = useGenerateConversationTitle();
  // Track if title generation has been attempted for this conversation
  const titleGenerationAttemptedRef = useRef(false);

  const {
    messages,
    sendMessage,
    status,
    setMessages,
    stop,
    error,
    addToolResult,
  } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      credentials: "include",
      headers: {
        [EXTERNAL_AGENT_ID_HEADER]: "Archestra Chat",
      },
    }),
    id: conversationId,
    onFinish: () => {
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });

      // Attempt to generate title after first assistant response
      // This will be checked when messages update in the effect below
    },
    onError: (chatError) => {
      console.error("[ChatSession] Error occurred:", {
        conversationId,
        error: chatError,
        message: chatError.message,
      });
    },
    onToolCall: ({ toolCall }) => {
      if (
        toolCall.toolName ===
        TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME
      ) {
        setPendingCustomServerToolCall(toolCall);
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
  } as Parameters<typeof useChat>[0]);

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

  // Update session in ref whenever state changes
  useEffect(() => {
    const session: ChatSession = {
      conversationId,
      messages,
      sendMessage,
      stop,
      status,
      error,
      setMessages,
      addToolResult,
      pendingCustomServerToolCall,
      setPendingCustomServerToolCall,
      tokenUsage,
    };

    sessionsRef.current.set(conversationId, session);
    // Notify that session has been updated so consumers re-render
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
    pendingCustomServerToolCall,
    tokenUsage,
    sessionsRef,
    notifySessionUpdate,
  ]);

  return null;
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
