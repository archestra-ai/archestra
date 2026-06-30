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
  /** Latest owned-app version this entry shows. */
  version?: number | null;
  /** Timestamp (ms) when the app first registered — used to order entries and default to the latest. */
  createdAt: number;
}

interface AppsContextValue {
  /** All apps currently mounted in the conversation, in the order they appeared. */
  apps: PanelApp[];
  /** toolCallId of the app currently displayed in the panel (session-only). */
  selectedToolCallId: string | null;
  /** Update which app the panel displays. */
  select: (toolCallId: string) => void;
  /** DOM node where the selected app should portal its content; null when the panel is not on the Apps tab. */
  portalTarget: HTMLElement | null;
  setPortalTarget: (el: HTMLElement | null) => void;
  /** Open the panel on the Apps tab and select this app. Wired by the chat page. */
  showInPanel: (toolCallId: string) => void;
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
  selectedToolCallId: null,
  select: () => {},
  portalTarget: null,
  setPortalTarget: () => {},
  showInPanel: () => {},
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
  /** Called when an app requests to be shown in the panel — wire this to open the panel and switch to the Apps tab. */
  onShowInPanel?: (toolCallId: string) => void;
  /** Called to close the right panel — wire this to collapse the panel. */
  onClosePanel?: () => void;
  children: ReactNode;
}) {
  const [explicitSelection, setExplicitSelection] = useState<string | null>(
    null,
  );
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The panel shows the user's explicit choice while it's still present;
  // otherwise it defaults to the latest (most recently registered) app. A stale
  // selection from a previous conversation simply isn't found and falls through
  // to the latest, so no reset is needed when conversations switch.
  const selectedToolCallId = useMemo(() => {
    if (
      explicitSelection &&
      apps.some((a) => a.toolCallId === explicitSelection)
    ) {
      return explicitSelection;
    }
    return (
      apps.reduce<PanelApp | null>(
        (latest, a) =>
          !latest || a.createdAt >= latest.createdAt ? a : latest,
        null,
      )?.toolCallId ?? null
    );
  }, [explicitSelection, apps]);

  // Switching which app the panel shows always returns to the live app — the
  // settings form belongs to the app that was open, not the one switched to.
  const select = useCallback((toolCallId: string) => {
    setExplicitSelection(toolCallId);
    setSettingsOpen(false);
  }, []);

  const showInPanel = useCallback(
    (toolCallId: string) => {
      setExplicitSelection(toolCallId);
      setSettingsOpen(false);
      onShowInPanel?.(toolCallId);
    },
    [onShowInPanel],
  );

  const closePanel = useCallback(() => {
    setSettingsOpen(false);
    onClosePanel?.();
  }, [onClosePanel]);

  const value = useMemo<AppsContextValue>(
    () => ({
      apps,
      selectedToolCallId,
      select,
      portalTarget,
      setPortalTarget,
      showInPanel,
      closePanel,
      settingsOpen,
      setSettingsOpen,
    }),
    [
      apps,
      selectedToolCallId,
      select,
      portalTarget,
      showInPanel,
      closePanel,
      settingsOpen,
    ],
  );

  return <AppsContext.Provider value={value}>{children}</AppsContext.Provider>;
}

export function useApps(): AppsContextValue {
  return useContext(AppsContext) ?? NOOP_VALUE;
}
