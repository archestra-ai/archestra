import {
  findTabById,
  hasDuplicateValues,
  isSome,
} from "./browser-stream.state.helpers";
import {
  type BrowserState,
  type BrowserStateError,
  Err,
  Ok,
  type Result,
} from "./browser-stream.state.types";

export const validateBrowserState = (params: {
  state: BrowserState;
}): Result<BrowserStateError, BrowserState> => {
  const { state } = params;

  const tabIds = state.tabs.map((tab) => tab.id);
  const duplicateTabIds = hasDuplicateValues(tabIds);
  if (duplicateTabIds.length > 0) {
    return Err({ kind: "DuplicateTabId", tabId: duplicateTabIds[0] });
  }

  const duplicateTabOrder = hasDuplicateValues(state.tabOrder);
  if (duplicateTabOrder.length > 0) {
    return Err({ kind: "DuplicateTabOrder", tabIds: duplicateTabOrder });
  }

  const missingTabIds = state.tabOrder.filter(
    (tabId) => !tabIds.includes(tabId),
  );
  if (missingTabIds.length > 0) {
    return Err({ kind: "TabOrderMismatch", missingTabIds });
  }

  const activeTab = findTabById(state.tabs, state.activeTabId);
  if (!activeTab) {
    return Err({ kind: "ActiveTabMissing", activeTabId: state.activeTabId });
  }

  const indices = state.tabs.flatMap((tab) =>
    isSome(tab.index) ? [tab.index.value] : [],
  );
  const duplicateIndices = hasDuplicateValues(indices);
  if (duplicateIndices.length > 0) {
    return Err({ kind: "DuplicateTabIndex", indices: duplicateIndices });
  }

  return Ok(state);
};
