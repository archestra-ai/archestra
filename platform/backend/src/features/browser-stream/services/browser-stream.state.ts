import {
  findTabById,
  hasDuplicateValues,
  isSome,
  uniqueValues,
} from "./browser-stream.state.helpers";
import {
  type BrowserState,
  type BrowserStateError,
  type BrowserTabId,
  type BrowserTabState,
  type BrowserTabsListEntry,
  Err,
  Ok,
  type Result,
  Some,
} from "./browser-stream.state.types";

export const resolveIndexForTab = (params: {
  state: BrowserState;
  tabId: BrowserTabId;
}): Result<BrowserStateError, number> => {
  const { state, tabId } = params;
  const tab = findTabById(state.tabs, tabId);
  if (!tab) {
    return Err({ kind: "TabNotFound", tabId });
  }
  if (!isSome(tab.index)) {
    return Err({ kind: "TabIndexUnavailable", tabId });
  }
  return Ok(tab.index.value);
};

export const resolveTabIdForIndex = (params: {
  state: BrowserState;
  index: number;
}): Result<BrowserStateError, BrowserTabId> => {
  const { state, index } = params;
  const match = state.tabs.find(
    (tab) => isSome(tab.index) && tab.index.value === index,
  );
  if (!match) {
    return Err({ kind: "TabIndexNotFound", index });
  }
  return Ok(match.id);
};

export const applyTabsList = (params: {
  state: BrowserState;
  list: BrowserTabsListEntry[];
}): Result<BrowserStateError, BrowserState> => {
  const { state, list } = params;
  if (list.length !== state.tabOrder.length) {
    return Err({
      kind: "TabCountMismatch",
      expected: state.tabOrder.length,
      actual: list.length,
    });
  }

  const indices = list.map((entry) => entry.index);
  const duplicateIndices = hasDuplicateValues(indices);
  if (duplicateIndices.length > 0) {
    return Err({ kind: "DuplicateTabIndex", indices: duplicateIndices });
  }

  const currentIndices = list
    .filter((entry) => entry.isCurrent)
    .map((entry) => entry.index);
  const uniqueCurrentIndices = uniqueValues(currentIndices);
  if (uniqueCurrentIndices.length > 1) {
    return Err({
      kind: "MultipleCurrentTabs",
      indices: uniqueCurrentIndices,
    });
  }

  const indexByTabId = new Map<BrowserTabId, number>();
  for (let i = 0; i < state.tabOrder.length; i += 1) {
    const tabId = state.tabOrder[i];
    const listEntry = list[i];
    indexByTabId.set(tabId, listEntry.index);
  }

  const updatedTabs = state.tabs.map((tab) => {
    const index = indexByTabId.get(tab.id);
    return index === undefined ? tab : { ...tab, index: Some(index) };
  });

  let activeTabId = state.activeTabId;
  if (uniqueCurrentIndices.length === 1) {
    const currentIndex = uniqueCurrentIndices[0];
    const position = list.findIndex((entry) => entry.index === currentIndex);
    const tabId = state.tabOrder[position];
    if (tabId) {
      activeTabId = tabId;
    }
  }

  return Ok({
    ...state,
    activeTabId,
    tabs: updatedTabs,
  });
};

export const applyTabsCreate = (params: {
  state: BrowserState;
  tabId: BrowserTabId;
  index: number;
  initialUrl: string;
}): Result<BrowserStateError, BrowserState> => {
  const { state, tabId, index, initialUrl } = params;
  if (state.tabs.some((tab) => tab.id === tabId)) {
    return Err({ kind: "DuplicateTabId", tabId });
  }

  const indexInUse = state.tabs.some(
    (tab) => isSome(tab.index) && tab.index.value === index,
  );
  if (indexInUse) {
    return Err({ kind: "DuplicateTabIndex", indices: [index] });
  }

  const newTab: BrowserTabState = {
    id: tabId,
    index: Some(index),
    current: initialUrl,
  };

  return Ok({
    activeTabId: tabId,
    tabOrder: [...state.tabOrder, tabId],
    tabs: [...state.tabs, newTab],
  });
};

export const applyTabsClose = (params: {
  state: BrowserState;
  index: number;
}): Result<BrowserStateError, BrowserState> => {
  const { state, index } = params;
  const tabResult = resolveTabIdForIndex({ state, index });
  if (tabResult.tag === "Err") {
    return tabResult;
  }
  const tabId = tabResult.value;

  if (state.tabs.length <= 1) {
    return Err({ kind: "CannotCloseLastTab" });
  }

  const remainingTabs = state.tabs
    .filter((tab) => tab.id !== tabId)
    .map((tab) => {
      if (!isSome(tab.index)) {
        return tab;
      }
      if (tab.index.value > index) {
        return { ...tab, index: Some(tab.index.value - 1) };
      }
      return tab;
    });

  const remainingOrder = state.tabOrder.filter((id) => id !== tabId);

  let activeTabId = state.activeTabId;
  if (state.activeTabId === tabId) {
    const closedPosition = state.tabOrder.indexOf(tabId);
    const nextTabId =
      remainingOrder[closedPosition] ?? remainingOrder[closedPosition - 1];
    if (!nextTabId) {
      return Err({ kind: "CannotCloseLastTab" });
    }
    activeTabId = nextTabId;
  }

  return Ok({
    ...state,
    activeTabId,
    tabOrder: remainingOrder,
    tabs: remainingTabs,
  });
};

/**
 * Update the current URL for a tab without tracking history.
 * Used for page restoration when switching conversations.
 */
export const applyUpdateCurrentUrl = (params: {
  state: BrowserState;
  tabId: BrowserTabId;
  url: string;
}): Result<BrowserStateError, BrowserState> => {
  const { state, tabId, url } = params;
  const tab = findTabById(state.tabs, tabId);
  if (!tab) {
    return Err({ kind: "TabNotFound", tabId });
  }

  const updatedTabs = state.tabs.map((t) =>
    t.id === tabId ? { ...t, current: url } : t,
  );

  return Ok({
    ...state,
    tabs: updatedTabs,
  });
};
