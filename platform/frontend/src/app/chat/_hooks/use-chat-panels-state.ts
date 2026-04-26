"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";

const BROWSER_OPEN_KEY = "archestra-chat-browser-open";

export function useChatPanelsState(params: {
  conversationId: string | undefined;
  artifact: string | null | undefined;
  isLoadingConversation: boolean;
}) {
  const [isArtifactOpen, setIsArtifactOpen] = useState(false);
  const [pendingBrowserUrl, setPendingBrowserUrl] = useState<
    string | undefined
  >(undefined);
  const [isBrowserPanelOpen, setIsBrowserPanelOpen] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(BROWSER_OPEN_KEY) === "true";
    }
    return false;
  });
  const previousArtifactRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!params.conversationId) {
      setIsArtifactOpen(false);
      return;
    }

    if (params.isLoadingConversation) return;

    const { artifactOpen: artifactOpenKey } = conversationStorageKeys(
      params.conversationId,
    );
    const storedState = localStorage.getItem(artifactOpenKey);
    if (storedState !== null) {
      setIsArtifactOpen(storedState === "true");
    } else if (params.artifact) {
      setIsArtifactOpen(true);
      localStorage.setItem(artifactOpenKey, "true");
    } else {
      setIsArtifactOpen(false);
    }
  }, [params.conversationId, params.artifact, params.isLoadingConversation]);

  useEffect(() => {
    if (
      params.conversationId &&
      params.artifact &&
      previousArtifactRef.current !== undefined &&
      previousArtifactRef.current !== params.artifact &&
      !isArtifactOpen
    ) {
      setIsArtifactOpen(true);
      localStorage.setItem(
        conversationStorageKeys(params.conversationId).artifactOpen,
        "true",
      );
    }

    previousArtifactRef.current = params.artifact;
  }, [params.artifact, isArtifactOpen, params.conversationId]);

  const toggleArtifactPanel = useCallback(() => {
    setIsArtifactOpen((current) => {
      const newValue = !current;
      if (params.conversationId) {
        localStorage.setItem(
          conversationStorageKeys(params.conversationId).artifactOpen,
          String(newValue),
        );
      }
      return newValue;
    });
  }, [params.conversationId]);

  const toggleBrowserPanel = useCallback(() => {
    setIsBrowserPanelOpen((current) => {
      const newValue = !current;
      localStorage.setItem(BROWSER_OPEN_KEY, String(newValue));
      return newValue;
    });
  }, []);

  const closeBrowserPanel = useCallback(() => {
    setIsBrowserPanelOpen(false);
    localStorage.setItem(BROWSER_OPEN_KEY, "false");
  }, []);

  const handleInitialNavigateComplete = useCallback(() => {
    setPendingBrowserUrl(undefined);
  }, []);

  return {
    closeBrowserPanel,
    handleInitialNavigateComplete,
    isArtifactOpen,
    isBrowserPanelOpen,
    pendingBrowserUrl,
    setPendingBrowserUrl,
    toggleArtifactPanel,
    toggleBrowserPanel,
  };
}
