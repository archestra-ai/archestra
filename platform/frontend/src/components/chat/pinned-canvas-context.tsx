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

export interface CanvasInfo {
  toolCallId: string;
  /** Short, human-readable label for the canvas (typically the tool name without the server prefix). */
  label: string;
  /** MCP server name (the prefix portion of the full tool name), if available. */
  serverName?: string | null;
  /** Owned-app id, when this canvas is an Archestra-authored MCP App — used to collapse repeated renders of the same app to one entry. */
  appId?: string | null;
  /** Timestamp (ms) when the canvas first registered — used to render relative time. */
  createdAt: number;
}

interface PinnedCanvasContextValue {
  /** All canvases currently mounted in the conversation, in the order they appeared. */
  canvases: CanvasInfo[];
  /** toolCallId of the canvas currently displayed in the sidebar (session-only). */
  selectedCanvasId: string | null;
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
  selectedCanvasId: null,
  select: () => {},
  portalTarget: null,
  setPortalTarget: () => {},
  showInSidebar: () => {},
};

export function PinnedCanvasProvider({
  canvases,
  onShowInSidebar,
  children,
}: {
  /** Canvases for this conversation, derived from its messages by the caller. */
  canvases: CanvasInfo[];
  /** Called when a canvas requests to be shown in the sidebar — wire this to open the panel and switch to the canvas tab. */
  onShowInSidebar?: (toolCallId: string) => void;
  children: ReactNode;
}) {
  const [selectedCanvasId, setSelectedCanvasId] = useState<string | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  // Initial selection when the sidebar tab opens: keep the current selection if
  // still present, otherwise default to the latest canvas in the conversation.
  useEffect(() => {
    if (!portalTarget) return;
    if (
      selectedCanvasId &&
      canvases.some((c) => c.toolCallId === selectedCanvasId)
    ) {
      return;
    }
    setSelectedCanvasId(canvases[canvases.length - 1]?.toolCallId ?? null);
  }, [portalTarget, canvases, selectedCanvasId]);

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
      selectedCanvasId,
      select,
      portalTarget,
      setPortalTarget,
      showInSidebar,
    }),
    [canvases, selectedCanvasId, select, portalTarget, showInSidebar],
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
