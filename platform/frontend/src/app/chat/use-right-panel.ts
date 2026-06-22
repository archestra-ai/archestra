"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RightPanelTab } from "@/components/chat/right-side-panel";
import { useConversationFiles } from "@/lib/chat/chat.query";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";

interface UseRightPanelParams {
  conversationId: string | undefined;
  /** The conversation's artifact, if any — drives the mount-time files default and the auto-open-on-change rule. */
  artifact: string | null | undefined;
  isLoadingConversation: boolean;
  /**
   * toolCallId of the most recent live browser tool call (from the chat session).
   * Changes only when a new call streams in — never for replayed history — so a
   * change is the auto-open-Browser trigger. Null when none has occurred.
   */
  lastBrowserToolCallId: string | null;
  /** Whether the Browser tab is available for this agent. */
  showBrowserButton: boolean;
  /** Whether the playwright setup flow is showing (suppresses browser auto-open). */
  isPlaywrightSetupVisible: boolean;
}

export interface RightPanelState {
  isOpen: boolean;
  activeTab: RightPanelTab;
  /** Open the panel and switch to a tab. */
  openTab: (tab: RightPanelTab) => void;
  /** Switch the active tab without changing the panel's open state. */
  setActiveTab: (tab: RightPanelTab) => void;
  close: () => void;
  toggle: () => void;
}

/**
 * Owns the chat right-side panel's open/closed state and its active tab, plus
 * every rule that auto-opens the panel (artifact, generated files, browser tool
 * calls). The open/tab state is persisted per conversation as a single
 * { open, tab } value, so a conversation restores the panel exactly as the user
 * last left it. A persisted preference wins over the auto-open-on-mount default.
 */
export function useRightPanel({
  conversationId,
  artifact,
  isLoadingConversation,
  lastBrowserToolCallId,
  showBrowserButton,
  isPlaywrightSetupVisible,
}: UseRightPanelParams): RightPanelState {
  const [isOpen, setIsOpen] = useState(false);
  const [rawTab, setActiveTab] = useState<RightPanelTab>("files");

  // Browser tab is never the active tab when it's unavailable for the agent.
  const activeTab: RightPanelTab =
    !showBrowserButton && rawTab === "browser" ? "files" : rawTab;

  const openTab = useCallback((tab: RightPanelTab) => {
    setActiveTab(tab);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((open) => !open), []);

  // Mount-time init: restore the persisted { open, tab } preference if one
  // exists (it wins — and is how a project-started chat is seeded to open the
  // Files tab). Otherwise fall back to the default: open Files when the
  // conversation already carries an artifact or generated files.
  const { data: conversationFiles } = useConversationFiles(conversationId);
  const generatedCount = conversationFiles?.generated?.length ?? 0;
  const didInitRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!conversationId || isLoadingConversation) return;
    if (didInitRef.current === conversationId) return;

    const persisted = readPersistedPanelState(conversationId);
    if (persisted) {
      didInitRef.current = conversationId;
      setIsOpen(persisted.open);
      setActiveTab(persisted.tab);
      return;
    }

    // Wait for the files query before deciding, unless an artifact settles it.
    if (!artifact && conversationFiles === undefined) return;
    didInitRef.current = conversationId;
    if (artifact || generatedCount > 0) {
      openTab("files");
    }
  }, [
    conversationId,
    isLoadingConversation,
    artifact,
    conversationFiles,
    generatedCount,
    openTab,
  ]);

  // Persist the open/tab state once init has run, so it survives reloads and
  // re-navigation. Gated on init to avoid clobbering the stored value with the
  // default-closed state before hydration.
  useEffect(() => {
    if (!conversationId || didInitRef.current !== conversationId) return;
    writePersistedPanelState(conversationId, { open: isOpen, tab: rawTab });
  }, [conversationId, isOpen, rawTab]);

  // Auto-open the panel when a mid-conversation signal changes: a new browser
  // tool call opens Browser; an artifact change or a new generated file (when
  // there's no artifact) opens Files. Each signal is compared during render
  // against its previous value, so the first render never triggers, and a
  // conversation switch resyncs the baseline silently (mount-time init owns the
  // initial open). lastBrowserToolCallId only changes for live calls, so this
  // never fires for replayed history — no "seen" bookkeeping needed.
  const [prevSignals, setPrevSignals] = useState({
    conversationId,
    artifact,
    generatedCount,
    lastBrowserToolCallId,
  });
  if (prevSignals.conversationId !== conversationId) {
    setPrevSignals({
      conversationId,
      artifact,
      generatedCount,
      lastBrowserToolCallId,
    });
  } else if (
    artifact !== prevSignals.artifact ||
    generatedCount !== prevSignals.generatedCount ||
    lastBrowserToolCallId !== prevSignals.lastBrowserToolCallId
  ) {
    const browserCallStarted =
      !!lastBrowserToolCallId &&
      lastBrowserToolCallId !== prevSignals.lastBrowserToolCallId &&
      showBrowserButton &&
      !isPlaywrightSetupVisible;
    const artifactChanged = !!artifact && prevSignals.artifact !== artifact;
    const generatedArrived =
      !artifact && generatedCount > prevSignals.generatedCount;
    setPrevSignals({
      conversationId,
      artifact,
      generatedCount,
      lastBrowserToolCallId,
    });
    if (browserCallStarted) {
      openTab("browser");
    } else if (artifactChanged || generatedArrived) {
      openTab("files");
    }
  }

  return {
    isOpen,
    activeTab,
    openTab,
    setActiveTab,
    close,
    toggle,
  };
}

const RIGHT_PANEL_TABS: readonly RightPanelTab[] = [
  "files",
  "browser",
  "canvas",
];

function readPersistedPanelState(
  conversationId: string,
): { open: boolean; tab: RightPanelTab } | null {
  if (typeof window === "undefined") return null;
  const keys = conversationStorageKeys(conversationId);
  const open = localStorage.getItem(keys.rightPanelOpen);
  if (open === null) return null;
  const tab = localStorage.getItem(keys.rightPanelTab);
  return {
    open: open === "true",
    tab: isRightPanelTab(tab) ? tab : "files",
  };
}

function writePersistedPanelState(
  conversationId: string,
  state: { open: boolean; tab: RightPanelTab },
) {
  if (typeof window === "undefined") return;
  const keys = conversationStorageKeys(conversationId);
  localStorage.setItem(keys.rightPanelOpen, String(state.open));
  localStorage.setItem(keys.rightPanelTab, state.tab);
}

function isRightPanelTab(value: string | null): value is RightPanelTab {
  return value !== null && RIGHT_PANEL_TABS.includes(value as RightPanelTab);
}
