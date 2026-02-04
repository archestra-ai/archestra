export type Option<T> = { tag: "Some"; value: T } | { tag: "None" };

export const Some = <T>(value: T): Option<T> => ({ tag: "Some", value });
export const None: Option<never> = { tag: "None" };

export type Result<E, T> = { tag: "Ok"; value: T } | { tag: "Err"; error: E };

export const Ok = <E, T>(value: T): Result<E, T> => ({ tag: "Ok", value });
export const Err = <E, T>(error: E): Result<E, T> => ({ tag: "Err", error });

export type NonEmptyArray<T> = [T, ...T[]];

export type BrowserTabId = string;

export type BrowserTabState = {
  id: BrowserTabId;
  index: Option<number>;
  current: string;
  history: NonEmptyArray<string>;
  historyCursor: number;
};

export type BrowserState = {
  activeTabId: BrowserTabId;
  tabOrder: BrowserTabId[];
  tabs: BrowserTabState[];
};

export type BrowserTabsListEntry = {
  index: number;
  isCurrent: boolean;
};

export type BrowserEffect =
  | { tag: "Navigate"; tabId: BrowserTabId; url: string }
  | { tag: "None" };

export type BrowserStateUpdate = {
  state: BrowserState;
  effect: BrowserEffect;
};

export type BrowserStateError =
  | { kind: "ActiveTabMissing"; activeTabId: BrowserTabId }
  | { kind: "DuplicateTabId"; tabId: BrowserTabId }
  | { kind: "DuplicateTabIndex"; indices: number[] }
  | { kind: "DuplicateTabOrder"; tabIds: BrowserTabId[] }
  | { kind: "TabOrderMismatch"; missingTabIds: BrowserTabId[] }
  | { kind: "TabNotFound"; tabId: BrowserTabId }
  | { kind: "TabIndexNotFound"; index: number }
  | { kind: "TabCountMismatch"; expected: number; actual: number }
  | { kind: "MultipleCurrentTabs"; indices: number[] }
  | {
      kind: "HistoryCursorOutOfBounds";
      tabId: BrowserTabId;
      historyLength: number;
      historyCursor: number;
    }
  | { kind: "CannotCloseLastTab" }
  | { kind: "NoBackHistory"; tabId: BrowserTabId }
  | { kind: "NoForwardHistory"; tabId: BrowserTabId }
  | { kind: "TabIndexUnavailable"; tabId: BrowserTabId };

/**
 * Persisted (database-safe) tab state - no runtime-only fields like index
 */
export type PersistedBrowserTabState = {
  current: string;
  history: NonEmptyArray<string>;
  historyCursor: number;
};

/**
 * Persisted (database-safe) browser state
 * Uses Record for tabs to enable lookup by ID without array scanning
 */
export type PersistedBrowserState = {
  activeTabId: BrowserTabId;
  tabOrder: BrowserTabId[];
  tabs: Record<BrowserTabId, PersistedBrowserTabState>;
};
