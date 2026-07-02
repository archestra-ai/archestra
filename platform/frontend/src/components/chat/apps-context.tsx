"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

export interface PanelApp {
  toolCallId: string;
  /** Short, human-readable label for the app (typically the tool name without the server prefix, or the owned-app name). */
  label: string;
  /**
   * Resource URI identifying the app — the dedup key. Owned apps use the
   * synthetic `ui://archestra-app/<appId>` (version-independent); external
   * MCP-UI tool calls use the URI from their result. Repeated renders of the
   * same URI collapse to one entry tracking the latest render.
   */
  uiResourceUri: string;
  /** Owned-app id, when this entry is an Archestra-authored app. External MCP-UI tool calls have none. */
  appId?: string | null;
  /**
   * Full prefixed tool name that produced this render (e.g. "server__tool").
   * Lets a sidebar-hosted render rebuild the app endpoint (server prefix) without
   * the originating message part. Always set by `deriveAppsFromMessages`.
   */
  toolName?: string;
  /**
   * Concrete install backing an external app rendered via a server-scoped deep
   * link (apps-page open-in-chat). When set, the chat mounts the resource
   * against this install (`/api/mcp/server/<id>`) instead of the agent gateway.
   * Live model-driven MCP-UI tool calls leave it unset (they use the agent).
   */
  mcpServerId?: string | null;
  /** Latest owned-app version this entry shows. */
  version?: number | null;
  /** Timestamp (ms) when the app first registered — used to order entries and default to the latest. */
  createdAt: number;
}

interface AppsContextValue {
  /** All apps currently mounted in the conversation, in the order they appeared. */
  apps: PanelApp[];
  /**
   * toolCallId of the single open app — the one shown either inline in the chat
   * stream or in the right panel. Every section derives its pressed / inline /
   * panel state from this one value; opening any app collapses the previous one
   * to a pill. Defaults to the latest app.
   */
  openToolCallId: string | null;
  /**
   * Set the single open app, or `null` to collapse (nothing open). Pills pass
   * their toolCallId to open, or `null` when they're already open to toggle
   * closed. Where the app then shows — inline or the right panel — is derived
   * from `portalTarget` (whether the Apps tab is hosting), not stored here.
   */
  setOpenToolCallId: (toolCallId: string | null) => void;
  /** Open the right panel on the Apps tab. Call alongside `setOpenToolCallId` to send an app there ("Open in right panel"). */
  openRightPanel: () => void;
  /** DOM node where the open app should portal its content; null when the panel is not on the Apps tab. */
  portalTarget: HTMLElement | null;
  setPortalTarget: (el: HTMLElement | null) => void;
  /** Close the right panel entirely. Wired by the chat page. */
  closePanel: () => void;
  /**
   * Whether the panel's owned-app shows its inline settings form instead of the
   * live app. Panel-level (not per-section) so it survives nothing across app
   * switches: selecting another app or closing the panel resets it to the app.
   */
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
}

const AppsContext = createContext<AppsContextValue | null>(null);

const NOOP_VALUE: AppsContextValue = {
  apps: [],
  openToolCallId: null,
  setOpenToolCallId: () => {},
  openRightPanel: () => {},
  portalTarget: null,
  setPortalTarget: () => {},
  closePanel: () => {},
  settingsOpen: false,
  setSettingsOpen: () => {},
};

export function AppsProvider({
  apps,
  onShowInPanel,
  onClosePanel,
  children,
}: {
  /** Apps for this conversation, derived from its messages by the caller. */
  apps: PanelApp[];
  /** Called to open the right panel on the Apps tab. */
  onShowInPanel?: () => void;
  /** Called to close the right panel — wire this to collapse the panel. */
  onClosePanel?: () => void;
  children: ReactNode;
}) {
  // `undefined` = untouched, so the open app defaults to the latest; a string is
  // an explicit choice; `null` is an explicit collapse (nothing open).
  const [explicitOpen, setExplicitOpen] = useState<string | null | undefined>(
    undefined,
  );
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Resolve the open app: untouched → the latest (most recently registered) app;
  // an explicit collapse (`null`) → nothing; an explicit choice → that app while
  // it's still present. A stale choice (a superseded owned-app render, or an id
  // from a previous conversation) isn't found and falls through to the latest,
  // so a new render of an owned app takes focus and no reset is needed on switch.
  const openToolCallId = useMemo(() => {
    const latestToolCallId =
      apps.reduce<PanelApp | null>(
        (latest, a) =>
          !latest || a.createdAt >= latest.createdAt ? a : latest,
        null,
      )?.toolCallId ?? null;
    // An explicit collapse (null) empties the inline stream, but the panel
    // always hosts one app when the conversation has any — fall back to the
    // latest there so the Apps tab never renders blank.
    if (explicitOpen === null) return portalTarget ? latestToolCallId : null;
    if (explicitOpen && apps.some((a) => a.toolCallId === explicitOpen)) {
      return explicitOpen;
    }
    return latestToolCallId;
  }, [explicitOpen, apps, portalTarget]);

  // Setting the open app always returns to the live app — the settings form
  // belongs to the app that was open, not the one switched to.
  const setOpenToolCallId = useCallback((toolCallId: string | null) => {
    setExplicitOpen(toolCallId);
    setSettingsOpen(false);
  }, []);

  const openRightPanel = useCallback(() => {
    onShowInPanel?.();
  }, [onShowInPanel]);

  const closePanel = useCallback(() => {
    setSettingsOpen(false);
    onClosePanel?.();
  }, [onClosePanel]);

  const value = useMemo<AppsContextValue>(
    () => ({
      apps,
      openToolCallId,
      setOpenToolCallId,
      openRightPanel,
      portalTarget,
      setPortalTarget,
      closePanel,
      settingsOpen,
      setSettingsOpen,
    }),
    [
      apps,
      openToolCallId,
      setOpenToolCallId,
      openRightPanel,
      portalTarget,
      closePanel,
      settingsOpen,
    ],
  );

  return <AppsContext.Provider value={value}>{children}</AppsContext.Provider>;
}

export function useApps(): AppsContextValue {
  return useContext(AppsContext) ?? NOOP_VALUE;
}
