import { randomUUID } from "node:crypto";
import {
  type BrowserState,
  type BrowserTabId,
  type BrowserTabState,
  None,
  type PersistedBrowserState,
  type PersistedBrowserTabState,
} from "./browser-stream.state.types";

/**
 * Generate a unique browser tab ID
 */
export const generateTabId = (): BrowserTabId => randomUUID();

/**
 * Convert runtime state to persisted state (drop index, convert array to Record)
 */
export const toPersistedState = (
  runtime: BrowserState,
): PersistedBrowserState => {
  const tabs: Record<BrowserTabId, PersistedBrowserTabState> = {};

  for (const tab of runtime.tabs) {
    tabs[tab.id] = {
      current: tab.current,
    };
  }

  return {
    activeTabId: runtime.activeTabId,
    tabOrder: runtime.tabOrder,
    tabs,
  };
};

/**
 * Convert persisted state to runtime state (add None for index, convert Record to array)
 */
export const toRuntimeState = (
  persisted: PersistedBrowserState,
): BrowserState => {
  const tabs: BrowserTabState[] = persisted.tabOrder.map((tabId) => {
    const persistedTab = persisted.tabs[tabId];
    return {
      id: tabId,
      index: None,
      current: persistedTab.current,
    };
  });

  return {
    activeTabId: persisted.activeTabId,
    tabOrder: persisted.tabOrder,
    tabs,
  };
};

/**
 * Create initial browser state for a new conversation
 */
export const createInitialState = (
  tabId: BrowserTabId,
  initialUrl: string,
): BrowserState => {
  const tab: BrowserTabState = {
    id: tabId,
    index: None,
    current: initialUrl,
  };

  return {
    activeTabId: tabId,
    tabOrder: [tabId],
    tabs: [tab],
  };
};
