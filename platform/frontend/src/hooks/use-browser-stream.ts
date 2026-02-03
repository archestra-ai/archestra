"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import websocketService from "@/lib/websocket";

interface UseBrowserStreamOptions {
  conversationId: string | undefined;
  isActive: boolean;
}

interface UseBrowserStreamReturn {
  screenshot: string | null;
  urlInput: string;
  isConnected: boolean;
  isConnecting: boolean;
  isNavigating: boolean;
  isInteracting: boolean;
  error: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  navigate: (url: string) => void;
  navigateBack: () => void;
  navigateForward: () => void;
  click: (x: number, y: number) => void;
  type: (text: string) => void;
  pressKey: (key: string) => void;
  setUrlInput: (url: string) => void;
  setIsEditingUrl: (isEditing: boolean) => void;
  isEditingUrl: boolean;
}

export function useBrowserStream({
  conversationId,
  isActive,
}: UseBrowserStreamOptions): UseBrowserStreamReturn {
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState<string>("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isNavigating, setIsNavigating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isEditingUrl, setIsEditingUrl] = useState(false);
  const [isInteracting, setIsInteracting] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  const subscribedConversationIdRef = useRef<string | null>(null);
  const prevConversationIdRef = useRef<string | undefined>(undefined);
  const isEditingUrlRef = useRef(false);
  // Keep ref in sync with state for use in subscription callbacks
  useEffect(() => {
    isEditingUrlRef.current = isEditingUrl;
  }, [isEditingUrl]);

  // Subscribe to browser stream via existing WebSocket
  useEffect(() => {
    if (!isActive || !conversationId) {
      // Unsubscribe when panel closes
      if (subscribedConversationIdRef.current) {
        websocketService.send({
          type: "unsubscribe_browser_stream",
          payload: { conversationId: subscribedConversationIdRef.current },
        });
        subscribedConversationIdRef.current = null;
      }
      setIsConnected(false);
      setScreenshot(null);
      prevConversationIdRef.current = conversationId;
      return;
    }

    // Clear state when switching conversations
    const isConversationSwitch =
      prevConversationIdRef.current !== undefined &&
      prevConversationIdRef.current !== conversationId;

    if (isConversationSwitch) {
      if (subscribedConversationIdRef.current) {
        websocketService.send({
          type: "unsubscribe_browser_stream",
          payload: { conversationId: subscribedConversationIdRef.current },
        });
        subscribedConversationIdRef.current = null;
      }
      setScreenshot(null);
      setUrlInput("");
      setIsConnected(false);
      setIsEditingUrl(false);
    }

    prevConversationIdRef.current = conversationId;

    setIsConnecting(true);
    setError(null);

    websocketService.connect();

    const unsubScreenshot = websocketService.subscribe(
      "browser_screenshot",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          setScreenshot(message.payload.screenshot);
          if (message.payload.url && !isEditingUrlRef.current) {
            setUrlInput(message.payload.url);
          }
          // Update navigation state
          setCanGoBack(message.payload.canGoBack ?? false);
          setCanGoForward(message.payload.canGoForward ?? false);
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
            setError(message.payload.error);
          }
        }
      },
    );

    const unsubError = websocketService.subscribe(
      "browser_stream_error",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          setError(message.payload.error);
          setIsConnecting(false);
        }
      },
    );

    const unsubClick = websocketService.subscribe(
      "browser_click_result",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          setIsInteracting(false);
          if (!message.payload.success && message.payload.error) {
            setError(message.payload.error);
          }
        }
      },
    );

    const unsubType = websocketService.subscribe(
      "browser_type_result",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          setIsInteracting(false);
          if (!message.payload.success && message.payload.error) {
            setError(message.payload.error);
          }
        }
      },
    );

    const unsubPressKey = websocketService.subscribe(
      "browser_press_key_result",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          setIsInteracting(false);
          if (!message.payload.success && message.payload.error) {
            setError(message.payload.error);
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
            setError(message.payload.error);
          }
        }
      },
    );

    const unsubNavigateForward = websocketService.subscribe(
      "browser_navigate_forward_result",
      (message) => {
        if (message.payload.conversationId === conversationId) {
          setIsNavigating(false);
          if (message.payload.success) {
            // Navigation message removed - user doesn't want these in chat
          } else if (message.payload.error) {
            setError(message.payload.error);
          }
        }
      },
    );

    const subscribeTimeout = setTimeout(() => {
      websocketService.send({
        type: "subscribe_browser_stream",
        payload: { conversationId },
      });
      subscribedConversationIdRef.current = conversationId;
    }, 100);

    return () => {
      clearTimeout(subscribeTimeout);
      unsubScreenshot();
      unsubNavigate();
      unsubError();
      unsubClick();
      unsubType();
      unsubPressKey();
      unsubNavigateBack();
      unsubNavigateForward();

      if (subscribedConversationIdRef.current) {
        websocketService.send({
          type: "unsubscribe_browser_stream",
          payload: { conversationId: subscribedConversationIdRef.current },
        });
        subscribedConversationIdRef.current = null;
      }
    };
  }, [isActive, conversationId]);

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
    [conversationId],
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

  const navigateForward = useCallback(() => {
    if (!websocketService.isConnected() || !conversationId) return;

    setIsNavigating(true);
    setError(null);

    websocketService.send({
      type: "browser_navigate_forward",
      payload: { conversationId },
    });
  }, [conversationId]);

  const click = useCallback(
    (x: number, y: number) => {
      if (!websocketService.isConnected() || !conversationId) return;

      setIsInteracting(true);
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

      setIsInteracting(true);
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

      setIsInteracting(true);
      setError(null);

      websocketService.send({
        type: "browser_press_key",
        payload: { conversationId, key },
      });
    },
    [conversationId],
  );

  return {
    screenshot,
    urlInput,
    isConnected,
    isConnecting,
    isNavigating,
    isInteracting,
    error,
    canGoBack,
    canGoForward,
    navigate,
    navigateBack,
    navigateForward,
    click,
    type,
    pressKey,
    setUrlInput,
    setIsEditingUrl,
    isEditingUrl,
  };
}
