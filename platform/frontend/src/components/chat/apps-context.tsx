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
  showInSidebar: (toolCallId: string) => void;
}

const AppsContext = createContext<AppsContextValue | null>(null);

const NOOP_VALUE: AppsContextValue = {
  apps: [],
  selectedToolCallId: null,
  select: () => {},
  portalTarget: null,
  setPortalTarget: () => {},
  showInSidebar: () => {},
};

export function AppsProvider({
  apps,
  onShowInSidebar,
  children,
}: {
  /** Apps for this conversation, derived from its messages by the caller. */
  apps: PanelApp[];
  /** Called when an app requests to be shown in the panel — wire this to open the panel and switch to the Apps tab. */
  onShowInSidebar?: (toolCallId: string) => void;
  children: ReactNode;
}) {
  const [explicitSelection, setExplicitSelection] = useState<string | null>(
    null,
  );
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

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

  const select = useCallback((toolCallId: string) => {
    setExplicitSelection(toolCallId);
  }, []);

  const showInSidebar = useCallback(
    (toolCallId: string) => {
      setExplicitSelection(toolCallId);
      onShowInSidebar?.(toolCallId);
    },
    [onShowInSidebar],
  );

  const value = useMemo<AppsContextValue>(
    () => ({
      apps,
      selectedToolCallId,
      select,
      portalTarget,
      setPortalTarget,
      showInSidebar,
    }),
    [apps, selectedToolCallId, select, portalTarget, showInSidebar],
  );

  return <AppsContext.Provider value={value}>{children}</AppsContext.Provider>;
}

export function useApps(): AppsContextValue {
  return useContext(AppsContext) ?? NOOP_VALUE;
}
