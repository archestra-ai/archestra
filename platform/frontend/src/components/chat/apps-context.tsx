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
import { buildAppGroups } from "./apps-context.utils";
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
  /**
   * Make this render its app's visible one and ensure it is open — without the
   * toggle semantics. Used when a pill click dismisses the panel-hosted copy:
   * the app must expand under the clicked pill, not wherever it last was.
   */
  focusAppRender: (toolCallId: string) => void;
  /** The single app the right panel hosts: the explicit pick (until a newer render arrives), else the latest still-open app, else the latest — never blank. */
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
  focusAppRender: () => {},
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
  // Apps the user explicitly collapsed, keyed per app (an `AppGroup.key`).
  // Everything expands by default, so a new app auto-opens by being absent here.
  const [closedKeys, setClosedKeys] = useState<ReadonlySet<string>>(EMPTY_SET);
  // Which render of an owned app the user picked as visible (appId → toolCallId);
  // absent → the latest. Clicking an older owned pill points it here.
  const [pickedOwnedRender, setPickedOwnedRender] =
    useState<ReadonlyMap<string, string>>(EMPTY_MAP);
  // Explicit right-panel pick, plus a snapshot of the renders that existed when
  // it was made. The pick pins the panel only against those renders: a render
  // arriving later (a new model-triggered app) supersedes it, so the panel
  // returns to the latest-still-open default and hosts the new app.
  const [explicitPanel, setExplicitPanel] = useState<{
    toolCallId: string;
    knownToolCallIds: ReadonlySet<string>;
  } | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [settingsToolCallId, setSettingsToolCallId] = useState<string | null>(
    null,
  );

  // One group per app: owned renders fold into a shared group with a single
  // visible `activeRender` (the user's pick while present, else the latest);
  // external renders are singleton groups. `groupByToolCallId` maps any render to
  // its group so every callback below is an O(1) lookup instead of a scan.
  const { groupByToolCallId } = useMemo(
    () => buildAppGroups(apps, pickedOwnedRender),
    [apps, pickedOwnedRender],
  );

  // The visible (canonical) render for an app: its group's active render. An
  // unknown id (e.g. a render not yet in `apps`) is its own canonical render.
  const canonicalToolCallId = useCallback(
    (id: string) => groupByToolCallId.get(id)?.activeRender.toolCallId ?? id,
    [groupByToolCallId],
  );

  // Open when this is the group's active render and the group isn't collapsed.
  // An unknown id is treated as its own default-open singleton.
  const isAppOpen = useCallback(
    (id: string) => {
      const group = groupByToolCallId.get(id);
      if (!group) return !closedKeys.has(id);
      return group.activeRender.toolCallId === id && !closedKeys.has(group.key);
    },
    [groupByToolCallId, closedKeys],
  );

  // Collapse when this render is the visible, open one; otherwise make it the
  // visible render (moving an owned dup here) and open the app.
  const toggleAppOpen = useCallback(
    (id: string) => {
      const group = groupByToolCallId.get(id);
      const key = group?.key ?? id;
      const appId = group?.appId ?? null;
      const visibleHere = (group?.activeRender.toolCallId ?? id) === id;
      if (visibleHere && !closedKeys.has(key)) {
        setClosedKeys((prev) => new Set(prev).add(key));
      } else {
        if (appId) {
          setPickedOwnedRender((prev) => new Map(prev).set(appId, id));
        }
        setClosedKeys((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
      setSettingsToolCallId(null);
    },
    [groupByToolCallId, closedKeys],
  );

  // Non-toggling variant of toggleAppOpen: point the app's group at this
  // render and open it, regardless of prior open/pick state.
  const focusAppRender = useCallback(
    (id: string) => {
      const group = groupByToolCallId.get(id);
      const key = group?.key ?? id;
      const appId = group?.appId ?? null;
      if (appId) {
        setPickedOwnedRender((prev) => new Map(prev).set(appId, id));
      }
      setClosedKeys((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setSettingsToolCallId(null);
    },
    [groupByToolCallId],
  );

  // Switching the panel app drops the previous app's settings form.
  const setPanelApp = useCallback(
    (id: string) => {
      setExplicitPanel({
        toolCallId: canonicalToolCallId(id),
        knownToolCallIds: new Set(apps.map((a) => a.toolCallId)),
      });
      setSettingsToolCallId(null);
    },
    [canonicalToolCallId, apps],
  );

  // One hosted app, never blank: explicit pick, else latest still-open active
  // render, else the latest active render overall.
  const panelToolCallId = useMemo(() => {
    // Honor the pick only while no render has arrived since it was made — a
    // newly rendered app supersedes it and takes the panel via the fallbacks.
    const pick = explicitPanel;
    if (
      pick &&
      groupByToolCallId.has(pick.toolCallId) &&
      apps.every((a) => pick.knownToolCallIds.has(a.toolCallId))
    ) {
      return pick.toolCallId;
    }
    const isActive = (a: PanelApp) =>
      groupByToolCallId.get(a.toolCallId)?.activeRender.toolCallId ===
      a.toolCallId;
    const latestBy = (predicate: (a: PanelApp) => boolean) =>
      apps
        .filter(predicate)
        .reduce<PanelApp | null>(
          (latest, a) =>
            !latest || a.createdAt >= latest.createdAt ? a : latest,
          null,
        )?.toolCallId ?? null;
    const latestOpen = latestBy(
      (a) =>
        isActive(a) &&
        !closedKeys.has(
          groupByToolCallId.get(a.toolCallId)?.key ?? a.toolCallId,
        ),
    );
    return latestOpen ?? latestBy(isActive);
  }, [explicitPanel, apps, closedKeys, groupByToolCallId]);

  const settingsOpen =
    settingsToolCallId !== null && settingsToolCallId === panelToolCallId;
  const setSettingsOpen = useCallback(
    (open: boolean) => {
      setSettingsToolCallId(open ? panelToolCallId : null);
    },
    [panelToolCallId],
  );

  useEffect(() => {
    if (settingsToolCallId !== null && !settingsOpen) {
      setSettingsToolCallId(null);
    }
  }, [settingsOpen, settingsToolCallId]);

  const openRightPanel = useCallback(() => {
    onShowInPanel?.();
  }, [onShowInPanel]);

  const closePanel = useCallback(() => {
    setSettingsToolCallId(null);
    onClosePanel?.();
  }, [onClosePanel]);

  const value = useMemo<AppsContextValue>(
    () => ({
      apps,
      isAppOpen,
      toggleAppOpen,
      focusAppRender,
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
      focusAppRender,
      panelToolCallId,
      setPanelApp,
      canonicalToolCallId,
      openRightPanel,
      portalTarget,
      closePanel,
      settingsOpen,
      setSettingsOpen,
    ],
  );

  return <AppsContext.Provider value={value}>{children}</AppsContext.Provider>;
}

export function useApps(): AppsContextValue {
  return useContext(AppsContext) ?? NOOP_VALUE;
}
