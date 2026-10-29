"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import websocketService from "@/lib/websocket/websocket";

/** localStorage key for tracking the active browser conversation */
const ACTIVE_BROWSER_CONVERSATION_KEY = "activeBrowserConversation";

interface ActiveBrowserConversation {
  conversationId: string;
  agentId?: string;
  timestamp: number;
}

/**
 * Store the active browser conversation in localStorage.
 * Called when the main panel subscribes to a browser stream.
 */
export function setActiveBrowserConversation(
  conversationId: string,
  agentId?: string,
): void {
  const data: ActiveBrowserConversation = {
    conversationId,
    agentId,
    timestamp: Date.now(),
  };
  localStorage.setItem(ACTIVE_BROWSER_CONVERSATION_KEY, JSON.stringify(data));
}

/**
 * Get the active browser conversation from localStorage.
 */
export function getActiveBrowserConversation(): ActiveBrowserConversation | null {
  try {
    const data = localStorage.getItem(ACTIVE_BROWSER_CONVERSATION_KEY);
    if (data) {
      return JSON.parse(data) as ActiveBrowserConversation;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Clear the active browser conversation from localStorage.
 */
export function clearActiveBrowserConversation(): void {
  localStorage.removeItem(ACTIVE_BROWSER_CONVERSATION_KEY);
}

interface UseBrowserStreamOptions {
  conversationId: string | undefined;
  isActive: boolean;
  /** If true, this is a popup window that should follow the active conversation */
  isPopup?: boolean;
  /** Initial URL to navigate to when subscribing (used for new conversations) */
  initialUrl?: string;
}

interface UseBrowserStreamReturn {
  screenshot: string | null;
  urlInput: string;
  isConnected: boolean;
  isConnecting: boolean;
  isNavigating: boolean;
  isInteracting: boolean;
  /** Count of input actions that have finished, successfully or not. */
  settledInputs: number;
  error: string | null;
  canGoBack: boolean;
  navigate: (url: string) => void;
  navigateBack: () => void;
  click: (x: number, y: number) => void;
  type: (text: string) => void;
  pressKey: (key: string) => void;
  reconnect: () => void;
  scroll: (params: {
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
  }) => void;
  setUrlInput: (url: string) => void;
  setIsEditingUrl: (isEditing: boolean) => void;
  isEditingUrl: boolean;
}

export function useBrowserStream({
  conversationId: propConversationId,
  isActive,
  isPopup = false,
  initialUrl,
}: UseBrowserStreamOptions): UseBrowserStreamReturn {
  // For popups, track the active conversation from localStorage
  const [activeConversationId, setActiveConversationId] = useState<
    string | undefined
  >(() => {
    if (isPopup) {
      const active = getActiveBrowserConversation();
      return active?.conversationId;
    }
    return propConversationId;
  });

  // The effective conversationId: from prop for main panel, from localStorage for popup
  const conversationId = isPopup ? activeConversationId : propConversationId;

  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState<string>("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isNavigating, setIsNavigating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isEditingUrlState, setIsEditingUrlState] = useState(false);
  // Input actions run concurrently; their results arrive as each one settles
  const [pendingInputs, setPendingInputs] = useState(0);
  const [settledInputs, setSettledInputs] = useState(0);
  const settleInput = useCallback(() => {
    setPendingInputs((n) => Math.max(0, n - 1));
    setSettledInputs((n) => n + 1);
  }, []);
  const [canGoBack, setCanGoBack] = useState(false);

  const subscribedConversationIdRef = useRef<string | null>(null);
  const prevConversationIdRef = useRef<string | undefined>(undefined);
  const isEditingUrlRef = useRef(false);
  /** Track if subscription is paused due to window/tab losing focus */
  const isPausedDueToFocusRef = useRef(false);

  // Wrapper that updates BOTH ref (immediately) and state (for UI)
  // This prevents race conditions where screenshot updates come in
  // before the useEffect syncs the ref
  const setIsEditingUrl = useCallback((value: boolean) => {
    isEditingUrlRef.current = value;
    setIsEditingUrlState(value);
  }, []);

  // For popups, listen for storage changes to follow active conversation
  useEffect(() => {
    if (!isPopup) return;

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === ACTIVE_BROWSER_CONVERSATION_KEY && e.newValue) {
        try {
          const data = JSON.parse(e.newValue) as ActiveBrowserConversation;
          if (data.conversationId !== activeConversationId) {
            setActiveConversationId(data.conversationId);
          }
        } catch {
          // Ignore parse errors
        }
      }
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, [isPopup, activeConversationId]);

  // For main panel (not popup), store active conversation in localStorage when subscribing
  useEffect(() => {
    if (isPopup || !isActive || !conversationId) return;

    // Store active conversation for popups to follow
    setActiveBrowserConversation(conversationId);

    // Cleanup: clear localStorage when panel closes or conversation changes
    return () => {
      clearActiveBrowserConversation();
    };
  }, [isPopup, isActive, conversationId]);

  // Subscribe to browser stream via existing WebSocket
  useEffect(() => {
    // Clear state when conversation changes (including to/from undefined)
    const conversationChanged =
      prevConversationIdRef.current !== conversationId;

    if (conversationChanged) {
      // Unsubscribe from previous conversation
      if (subscribedConversationIdRef.current) {
        websocketService.send({
          type: "unsubscribe_browser_stream",
          payload: { conversationId: subscribedConversationIdRef.current },
        });
        subscribedConversationIdRef.current = null;
      }
      // Reset all state immediately
      setScreenshot(null);
      setUrlInput("");
      setIsConnected(false);
      setIsEditingUrl(false);
      setError(null);
      isPausedDueToFocusRef.current = false;
      prevConversationIdRef.current = conversationId;
    }

    if (!isActive || !conversationId) {
      return;
    }

    setIsConnecting(true);
    setError(null);

    websocketService.connect();

    // The server lost this socket's subscription (it was paused or the server
    // restarted): re-subscribe right away so the next action works
    const handleResultError = (error: string) => {
      if (error.startsWith(NOT_SUBSCRIBED_ERROR_PREFIX)) {
        isPausedDueToFocusRef.current = false;
        websocketService.send({
          type: "subscribe_browser_stream",
          payload: { conversationId },
        });
        subscribedConversationIdRef.current = conversationId;
        setError("Reconnected to the browser. Repeat your last action.");
        return;
      }
      setError(error);
    };

    const unsubScreenshot = websocketService.subscribe(
      "browser_screenshot",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          setScreenshot(message.payload.screenshot);
          if (message.payload.url && !isEditingUrlRef.current) {
            setUrlInput(message.payload.url);
          }
          // Quick frames during input carry no URL and leave this as it was
          if (message.payload.canGoBack !== undefined) {
            setCanGoBack(message.payload.canGoBack);
          }
          setError(null);
          setIsConnecting(false);
          setIsConnected(true);
        }
      },
    );

    const unsubNavigate = websocketService.subscribe(
      "browser_navigate_result",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          setIsNavigating(false);
          if (message.payload.success && message.payload.url) {
            // Navigation message removed - user doesn't want these in chat
          } else if (message.payload.error) {
            handleResultError(message.payload.error);
          }
        }
      },
    );

    const unsubError = websocketService.subscribe(
      "browser_stream_error",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          console.error("[BrowserStream] Error:", message.payload.error);
          setIsConnecting(false);
        }
      },
    );

    const unsubClick = websocketService.subscribe(
      "browser_click_result",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          settleInput();
          if (!message.payload.success && message.payload.error) {
            handleResultError(message.payload.error);
          }
        }
      },
    );

    const unsubType = websocketService.subscribe(
      "browser_type_result",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          settleInput();
          if (!message.payload.success && message.payload.error) {
            handleResultError(message.payload.error);
          }
        }
      },
    );

    const unsubPressKey = websocketService.subscribe(
      "browser_press_key_result",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          settleInput();
          if (!message.payload.success && message.payload.error) {
            handleResultError(message.payload.error);
          }
        }
      },
    );

    const unsubScroll = websocketService.subscribe(
      "browser_scroll_result",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          settleInput();
          if (!message.payload.success && message.payload.error) {
            handleResultError(message.payload.error);
          }
        }
      },
    );

    const unsubNavigateBack = websocketService.subscribe(
      "browser_navigate_back_result",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          setIsNavigating(false);
          if (message.payload.success) {
            // Navigation message removed - user doesn't want these in chat
          } else if (message.payload.error) {
            handleResultError(message.payload.error);
          }
        }
      },
    );

    const subscribeTimeout = setTimeout(() => {
      websocketService.send({
        type: "subscribe_browser_stream",
        payload: { conversationId, initialUrl },
      });
      subscribedConversationIdRef.current = conversationId;
    }, 100);

    // The server forgets subscriptions with the socket (e.g. on a backend
    // restart), so re-subscribe on every new connection unless paused
    const unsubConnection = websocketService.onConnectionChange((open) => {
      // A result in flight on the dropped socket will never arrive
      if (!open) {
        setPendingInputs(0);
        return;
      }
      if (
        subscribedConversationIdRef.current !== conversationId ||
        isPausedDueToFocusRef.current
      ) {
        return;
      }
      websocketService.send({
        type: "subscribe_browser_stream",
        payload: { conversationId },
      });
    });

    return () => {
      clearTimeout(subscribeTimeout);
      unsubConnection();
      unsubScreenshot();
      unsubNavigate();
      unsubError();
      unsubClick();
      unsubType();
      unsubPressKey();
      unsubScroll();
      unsubNavigateBack();

      if (subscribedConversationIdRef.current) {
        websocketService.send({
          type: "unsubscribe_browser_stream",
          payload: { conversationId: subscribedConversationIdRef.current },
        });
        subscribedConversationIdRef.current = null;
      }
    };
  }, [isActive, conversationId, setIsEditingUrl, initialUrl, settleInput]);

  // Handle window/tab visibility changes to pause/resume subscription
  // This prevents multiple browser windows from interfering with each other
  useEffect(() => {
    if (!isActive || !conversationId) return;

    const pauseSubscription = () => {
      if (
        subscribedConversationIdRef.current &&
        !isPausedDueToFocusRef.current
      ) {
        isPausedDueToFocusRef.current = true;
        websocketService.send({
          type: "unsubscribe_browser_stream",
          payload: { conversationId: subscribedConversationIdRef.current },
        });
      }
    };

    const resumeSubscription = () => {
      if (isPausedDueToFocusRef.current && conversationId) {
        isPausedDueToFocusRef.current = false;
        websocketService.send({
          type: "subscribe_browser_stream",
          payload: { conversationId, initialUrl },
        });
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        pauseSubscription();
      } else {
        resumeSubscription();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isActive, conversationId, initialUrl]);

  const navigate = useCallback(
    (url: string) => {
      if (!websocketService.isConnected() || !conversationId) return;
      if (!url.trim()) return;

      let normalizedUrl = url.trim();
      if (
        !normalizedUrl.startsWith("http://") &&
        !normalizedUrl.startsWith("https://")
      ) {
        normalizedUrl = `https://${normalizedUrl}`;
      }

      setIsNavigating(true);
      setError(null);
      setUrlInput(normalizedUrl);
      setIsEditingUrl(false);

      websocketService.send({
        type: "browser_navigate",
        payload: { conversationId, url: normalizedUrl },
      });
    },
    [conversationId, setIsEditingUrl],
  );

  const navigateBack = useCallback(() => {
    if (!websocketService.isConnected() || !conversationId) return;

    setIsNavigating(true);
    setError(null);

    websocketService.send({
      type: "browser_navigate_back",
      payload: { conversationId },
    });
  }, [conversationId]);

  const click = useCallback(
    (x: number, y: number) => {
      if (!websocketService.isConnected() || !conversationId) return;

      setPendingInputs((n) => n + 1);
      setError(null);

      websocketService.send({
        type: "browser_click",
        payload: { conversationId, x, y },
      });
    },
    [conversationId],
  );

  const type = useCallback(
    (text: string) => {
      if (!websocketService.isConnected() || !conversationId) return;
      if (!text) return;

      setPendingInputs((n) => n + 1);
      setError(null);

      websocketService.send({
        type: "browser_type",
        payload: { conversationId, text },
      });
    },
    [conversationId],
  );

  const pressKey = useCallback(
    (key: string) => {
      if (!websocketService.isConnected() || !conversationId) return;

      setPendingInputs((n) => n + 1);
      setError(null);

      websocketService.send({
        type: "browser_press_key",
        payload: { conversationId, key },
      });
    },
    [conversationId],
  );

  const scroll = useCallback(
    (params: { x: number; y: number; deltaX: number; deltaY: number }) => {
      if (!websocketService.isConnected() || !conversationId) return;

      setPendingInputs((n) => n + 1);
      setError(null);

      websocketService.send({
        type: "browser_scroll",
        payload: { conversationId, ...params },
      });
    },
    [conversationId],
  );

  /** Manually re-subscribe to this conversation's browser stream. */
  const reconnect = useCallback(() => {
    if (!conversationId) return;
    websocketService.connect();
    isPausedDueToFocusRef.current = false;
    setError(null);
    setPendingInputs(0);
    setIsNavigating(false);
    websocketService.send({
      type: "subscribe_browser_stream",
      payload: { conversationId },
    });
    subscribedConversationIdRef.current = conversationId;
  }, [conversationId]);

  return {
    reconnect,
    screenshot,
    urlInput,
    isConnected,
    isConnecting,
    isNavigating,
    isInteracting: pendingInputs > 0,
    settledInputs,
    error,
    canGoBack,
    navigate,
    navigateBack,
    click,
    type,
    pressKey,
    scroll,
    setUrlInput,
    setIsEditingUrl,
    isEditingUrl: isEditingUrlState,
  };
}

// Prefix of the server's error when an action arrives on a socket that holds
// no subscription for the conversation
const NOT_SUBSCRIBED_ERROR_PREFIX = "Not subscribed to this conversation";
