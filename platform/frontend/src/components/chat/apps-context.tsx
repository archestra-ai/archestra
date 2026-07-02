"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { McpToolOutput } from "./mcp-app-container";

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
  /**
   * External MCP-UI tool result, so a panel-hosted render can seed its iframe
   * (`sendToolResult`) exactly like the inline render instead of re-calling the
   * source tool. Owned apps have none (their management result is not app data).
   */
  rawOutput?: McpToolOutput | null;
  /** Tool input for the iframe; best-effort — only present on same-part results. */
  toolInput?: Record<string, unknown> | null;
  /** Timestamp (ms) when the app first registered — used to order entries and default to the latest. */
  createdAt: number;
}

interface AppsContextValue {
  /** All apps currently mounted in the conversation, in the order they appeared. */
  apps: PanelApp[];
  /** Whether this render is expanded inline. Apps expand by default; only the canonical (latest) owned render can. */
  isAppOpen: (toolCallId: string) => boolean;
  /** Toggle one app's inline expansion (canonicalized), leaving other open apps alone. */
  toggleAppOpen: (toolCallId: string) => void;
  /** The single app the right panel hosts: the explicit pick, else the latest still-open app, else the latest — never blank. */
  panelToolCallId: string | null;
  /** Point the right panel at an app (pill selector / "Open in right panel"). */
  setPanelApp: (toolCallId: string) => void;
  /** Map any render to the canonical render for its app (latest owned render, or itself). */
  canonicalToolCallId: (toolCallId: string) => string;
  /** Open the right panel on the Apps tab. */
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

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_MAP: ReadonlyMap<string, string> = new Map();

const NOOP_VALUE: AppsContextValue = {
  apps: [],
  isAppOpen: () => false,
  toggleAppOpen: () => {},
  panelToolCallId: null,
  setPanelApp: () => {},
  canonicalToolCallId: (id) => id,
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
  // Apps the user explicitly collapsed, keyed per app (see `openKeyByToolCallId`).
  // Everything expands by default, so a new app auto-opens by being absent here.
  const [closedKeys, setClosedKeys] = useState<ReadonlySet<string>>(EMPTY_SET);
  // Which render of an owned app is the visible one (appId → toolCallId); absent
  // → the latest. Clicking an older owned pill points it here.
  const [activeOwnedRender, setActiveOwnedRender] =
    useState<ReadonlyMap<string, string>>(EMPTY_MAP);
  // Explicit right-panel pick; null falls back to the latest still-open app.
  const [explicitPanelId, setExplicitPanelId] = useState<string | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Per render: its canonical (visible) render — the user-picked owned render
  // while present, else the latest — and its open-state key (appId for owned so
  // renders share one open state, else toolCallId).
  const { canonicalByToolCallId, openKeyByToolCallId } = useMemo(() => {
    const latestOwned = new Map<string, PanelApp>();
    for (const a of apps) {
      if (!a.appId) continue;
      const cur = latestOwned.get(a.appId);
      if (!cur || a.createdAt >= cur.createdAt) latestOwned.set(a.appId, a);
    }
    const canonicalForApp = new Map<string, string>();
    for (const [appId, latest] of latestOwned) {
      const picked = activeOwnedRender.get(appId);
      const pickedPresent = apps.some(
        (a) => a.toolCallId === picked && a.appId === appId,
      );
      canonicalForApp.set(
        appId,
        pickedPresent && picked ? picked : latest.toolCallId,
      );
    }
    const canonical = new Map<string, string>();
    const openKey = new Map<string, string>();
    for (const a of apps) {
      canonical.set(
        a.toolCallId,
        a.appId ? (canonicalForApp.get(a.appId) ?? a.toolCallId) : a.toolCallId,
      );
      openKey.set(a.toolCallId, a.appId ?? a.toolCallId);
    }
    return { canonicalByToolCallId: canonical, openKeyByToolCallId: openKey };
  }, [apps, activeOwnedRender]);

  const canonicalToolCallId = useCallback(
    (id: string) => canonicalByToolCallId.get(id) ?? id,
    [canonicalByToolCallId],
  );

  const latestToolCallId = useMemo(
    () =>
      apps.reduce<PanelApp | null>(
        (latest, a) =>
          !latest || a.createdAt >= latest.createdAt ? a : latest,
        null,
      )?.toolCallId ?? null,
    [apps],
  );

  // Open when this is the canonical render and its app isn't collapsed.
  const isAppOpen = useCallback(
    (id: string) =>
      canonicalToolCallId(id) === id &&
      !closedKeys.has(openKeyByToolCallId.get(id) ?? id),
    [canonicalToolCallId, closedKeys, openKeyByToolCallId],
  );

  // Collapse when this render is the visible, open one; otherwise make it the
  // visible render (moving an owned dup here) and open the app.
  const toggleAppOpen = useCallback(
    (id: string) => {
      const key = openKeyByToolCallId.get(id) ?? id;
      const visibleHere = canonicalToolCallId(id) === id;
      const appId = apps.find((a) => a.toolCallId === id)?.appId ?? null;
      if (visibleHere && !closedKeys.has(key)) {
        setClosedKeys((prev) => new Set(prev).add(key));
      } else {
        if (appId) {
          setActiveOwnedRender((prev) => new Map(prev).set(appId, id));
        }
        setClosedKeys((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
      setSettingsOpen(false);
    },
    [apps, canonicalToolCallId, closedKeys, openKeyByToolCallId],
  );

  // Switching the panel app drops the previous app's settings form.
  const setPanelApp = useCallback(
    (id: string) => {
      setExplicitPanelId(canonicalToolCallId(id));
      setSettingsOpen(false);
    },
    [canonicalToolCallId],
  );

  // One hosted app, never blank: explicit pick, else latest still-open, else latest.
  const panelToolCallId = useMemo(() => {
    if (explicitPanelId && apps.some((a) => a.toolCallId === explicitPanelId)) {
      return explicitPanelId;
    }
    const latestOpen = apps
      .filter(
        (a) =>
          canonicalByToolCallId.get(a.toolCallId) === a.toolCallId &&
          !closedKeys.has(
            openKeyByToolCallId.get(a.toolCallId) ?? a.toolCallId,
          ),
      )
      .reduce<PanelApp | null>(
        (latest, a) =>
          !latest || a.createdAt >= latest.createdAt ? a : latest,
        null,
      )?.toolCallId;
    return latestOpen ?? latestToolCallId;
  }, [
    explicitPanelId,
    apps,
    closedKeys,
    canonicalByToolCallId,
    openKeyByToolCallId,
    latestToolCallId,
  ]);

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
      isAppOpen,
      toggleAppOpen,
      panelToolCallId,
      setPanelApp,
      canonicalToolCallId,
      openRightPanel,
      portalTarget,
      setPortalTarget,
      closePanel,
      settingsOpen,
      setSettingsOpen,
    }),
    [
      apps,
      isAppOpen,
      toggleAppOpen,
      panelToolCallId,
      setPanelApp,
      canonicalToolCallId,
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
