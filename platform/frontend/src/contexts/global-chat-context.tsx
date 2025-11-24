"use client";

import { type UIMessage, useChat } from "@ai-sdk/react";
import { TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME } from "@shared";
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
  lastAccessTime: number;
  pendingCustomServerToolCall: {
    toolCallId: string;
    toolName: string;
  } | null;
  setPendingCustomServerToolCall: (
    value: { toolCallId: string; toolName: string } | null,
  ) => void;
}

interface ChatContextValue {
  registerSession: (conversationId: string) => void;
  getSession: (conversationId: string) => ChatSession | undefined;
  clearSession: (conversationId: string) => void;
  notifySessionUpdate: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const sessionsRef = useRef(new Map<string, ChatSession>());
  const cleanupTimersRef = useRef(new Map<string, NodeJS.Timeout>());
  const [activeSessions, setActiveSessions] = useState<Set<string>>(new Set());
  // Version counter to trigger re-renders when sessions update
  const [sessionVersion, setSessionVersion] = useState(0);

  // Increment version when sessions change (triggers re-renders in consumers)
  const notifySessionUpdate = useCallback(() => {
    setSessionVersion((v) => v + 1);
  }, []);

  // Schedule cleanup for inactive sessions
  const scheduleCleanup = useCallback((conversationId: string) => {
    // Clear existing timer
    const existingTimer = cleanupTimersRef.current.get(conversationId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule new cleanup
    const timer = setTimeout(() => {
      const session = sessionsRef.current.get(conversationId);
      if (
        session &&
        Date.now() - session.lastAccessTime >= SESSION_CLEANUP_TIMEOUT
      ) {
        sessionsRef.current.delete(conversationId);
        cleanupTimersRef.current.delete(conversationId);
        setActiveSessions((prev) => {
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
    setActiveSessions((prev) => {
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
      if (session) {
        // Update last access time
        session.lastAccessTime = Date.now();
        // Reschedule cleanup
        scheduleCleanup(conversationId);
      }
      return session;
    },
    [scheduleCleanup, sessionVersion],
  );

  // Clear a session manually
  const clearSession = useCallback(
    (conversationId: string) => {
      sessionsRef.current.delete(conversationId);
      const timer = cleanupTimersRef.current.get(conversationId);
      if (timer) {
        clearTimeout(timer);
        cleanupTimersRef.current.delete(conversationId);
      }
      setActiveSessions((prev) => {
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
      cleanupTimersRef.current.clear();
    };
  }, []);

  const value = useMemo(
    () => ({
      registerSession,
      getSession,
      clearSession,
      notifySessionUpdate,
    }),
    [registerSession, getSession, clearSession, notifySessionUpdate],
  );

  return (
    <ChatContext.Provider value={value}>
      {/* Render hidden session components for each active conversation */}
      {Array.from(activeSessions).map((conversationId) => (
        <ChatSessionHook
          key={conversationId}
          conversationId={conversationId}
          sessionsRef={sessionsRef}
          scheduleCleanup={scheduleCleanup}
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
  scheduleCleanup,
  notifySessionUpdate,
}: {
  conversationId: string;
  sessionsRef: React.MutableRefObject<Map<string, ChatSession>>;
  scheduleCleanup: (conversationId: string) => void;
  notifySessionUpdate: () => void;
}) {
  const queryClient = useQueryClient();
  const [pendingCustomServerToolCall, setPendingCustomServerToolCall] =
    useState<{ toolCallId: string; toolName: string } | null>(null);

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
    }),
    id: conversationId,
    onFinish: () => {
      queryClient.invalidateQueries({
        queryKey: ["conversation", conversationId],
      });
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
    },
  } as Parameters<typeof useChat>[0]);

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
      lastAccessTime: Date.now(),
      pendingCustomServerToolCall,
      setPendingCustomServerToolCall,
    };

    sessionsRef.current.set(conversationId, session);
    scheduleCleanup(conversationId);
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
    sessionsRef,
    scheduleCleanup,
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
  const { registerSession, getSession } = useGlobalChat();

  useEffect(() => {
    if (conversationId) {
      registerSession(conversationId);
    }
  }, [conversationId, registerSession]);

  return conversationId ? getSession(conversationId) : null;
}
