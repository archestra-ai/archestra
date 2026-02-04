import type {
  BrowserTabId,
  BrowserTabState,
  Option,
  Result,
} from "./browser-stream.state.types";

export const isSome = <T>(
  value: Option<T>,
): value is { tag: "Some"; value: T } => value.tag === "Some";

export const isOk = <E, T>(
  result: Result<E, T>,
): result is { tag: "Ok"; value: T } => result.tag === "Ok";

export const isErr = <E, T>(
  result: Result<E, T>,
): result is { tag: "Err"; error: E } => result.tag === "Err";

export const uniqueValues = <T>(values: T[]): T[] =>
  Array.from(new Set(values));

export const findTabById = (
  tabs: BrowserTabState[],
  tabId: BrowserTabId,
): BrowserTabState | undefined => tabs.find((tab) => tab.id === tabId);

export const updateTab = (
  tabs: BrowserTabState[],
  tabId: BrowserTabId,
  updater: (tab: BrowserTabState) => BrowserTabState,
): BrowserTabState[] =>
  tabs.map((tab) => (tab.id === tabId ? updater(tab) : tab));

export const hasDuplicateValues = <T>(values: T[]): T[] => {
  const seen = new Set<T>();
  const duplicates = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return Array.from(duplicates);
};
