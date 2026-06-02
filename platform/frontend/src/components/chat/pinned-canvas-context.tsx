"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";

export interface CanvasInfo {
  toolCallId: string;
  /** Short, human-readable label for the canvas (typically the tool name without the server prefix). */
  label: string;
  /** MCP server name (the prefix portion of the full tool name), if available. */
  serverName?: string | null;
  /** Timestamp (ms) when the canvas first registered — used to render relative time. */
  createdAt: number;
}

interface PinnedCanvasContextValue {
  /** All canvases currently mounted in the conversation, in the order they appeared. */
  canvases: CanvasInfo[];
  /** toolCallId of the canvas marked as default for this conversation (persisted). */
  pinnedCanvasId: string | null;
  /** toolCallId of the canvas currently displayed in the sidebar (session-only). */
  selectedCanvasId: string | null;
  /** Update the pinned (default) canvas. Pass null to unpin. */
  setPinned: (toolCallId: string | null) => void;
  /** Update which canvas the sidebar displays. */
  select: (toolCallId: string) => void;
  /** DOM node where the selected canvas should portal its content; null when sidebar is not on the MCP App tab. */
  portalTarget: HTMLElement | null;
  setPortalTarget: (el: HTMLElement | null) => void;
  /** Open the sidebar on the canvas tab and select this canvas. Wired by the chat page. */
  showInSidebar: (toolCallId: string) => void;
}

const PinnedCanvasContext = createContext<PinnedCanvasContextValue | null>(
  null,
);

const NOOP_VALUE: PinnedCanvasContextValue = {
  canvases: [],
  pinnedCanvasId: null,
  selectedCanvasId: null,
  setPinned: () => {},
  select: () => {},
  portalTarget: null,
  setPortalTarget: () => {},
  showInSidebar: () => {},
};

export function PinnedCanvasProvider({
  conversationId,
  canvases,
  onShowInSidebar,
  children,
}: {
  conversationId: string | undefined;
  /** Canvases for this conversation, derived from its messages by the caller. */
  canvases: CanvasInfo[];
  /** Called when a canvas requests to be shown in the sidebar — wire this to open the panel and switch to the canvas tab. */
  onShowInSidebar?: (toolCallId: string) => void;
  children: ReactNode;
}) {
  const [pinnedCanvasId, setPinnedCanvasId] = useState<string | null>(null);
  const [selectedCanvasId, setSelectedCanvasId] = useState<string | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  // Hydrate the pinned canvas id from localStorage when the conversation
  // changes.
  useEffect(() => {
    if (!conversationId || typeof window === "undefined") {
      setPinnedCanvasId(null);
      setSelectedCanvasId(null);
      return;
    }
    const key = conversationStorageKeys(conversationId).pinnedCanvas;
    setPinnedCanvasId(localStorage.getItem(key));
    setSelectedCanvasId(null);
  }, [conversationId]);

  // Initial selection when the sidebar tab opens: prefer the pinned canvas if
  // still present, otherwise pick the first registered canvas.
  useEffect(() => {
    if (!portalTarget) return;
    if (
      selectedCanvasId &&
      canvases.some((c) => c.toolCallId === selectedCanvasId)
    ) {
      return;
    }
    if (
      pinnedCanvasId &&
      canvases.some((c) => c.toolCallId === pinnedCanvasId)
    ) {
      setSelectedCanvasId(pinnedCanvasId);
      return;
    }
    setSelectedCanvasId(canvases[0]?.toolCallId ?? null);
  }, [portalTarget, pinnedCanvasId, canvases, selectedCanvasId]);

  const setPinned = useCallback(
    (toolCallId: string | null) => {
      setPinnedCanvasId(toolCallId);
      if (conversationId && typeof window !== "undefined") {
        const key = conversationStorageKeys(conversationId).pinnedCanvas;
        if (toolCallId) localStorage.setItem(key, toolCallId);
        else localStorage.removeItem(key);
      }
    },
    [conversationId],
  );

  const select = useCallback((toolCallId: string) => {
    setSelectedCanvasId(toolCallId);
  }, []);

  const showInSidebar = useCallback(
    (toolCallId: string) => {
      setSelectedCanvasId(toolCallId);
      onShowInSidebar?.(toolCallId);
    },
    [onShowInSidebar],
  );

  const value = useMemo<PinnedCanvasContextValue>(
    () => ({
      canvases,
      pinnedCanvasId,
      selectedCanvasId,
      setPinned,
      select,
      portalTarget,
      setPortalTarget,
      showInSidebar,
    }),
    [
      canvases,
      pinnedCanvasId,
      selectedCanvasId,
      setPinned,
      select,
      portalTarget,
      showInSidebar,
    ],
  );

  return (
    <PinnedCanvasContext.Provider value={value}>
      {children}
    </PinnedCanvasContext.Provider>
  );
}

export function usePinnedCanvas(): PinnedCanvasContextValue {
  return useContext(PinnedCanvasContext) ?? NOOP_VALUE;
}
