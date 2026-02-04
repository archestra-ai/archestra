import { describe, expect, test } from "@/test";
import {
  applyTabsClose,
  applyTabsCreate,
  applyTabsList,
  applyUpdateCurrentUrl,
  resolveIndexForTab,
  resolveTabIdForIndex,
} from "./browser-stream.state";
import {
  type BrowserState,
  type BrowserTabState,
  None,
  type Result,
  Some,
} from "./browser-stream.state.types";
import { validateBrowserState } from "./browser-stream.state.validation";

const makeTab = (params: {
  id: string;
  index: number | null;
  current: string;
}): BrowserTabState => ({
  id: params.id,
  index: params.index === null ? None : Some(params.index),
  current: params.current,
});

const makeState = (): BrowserState => ({
  activeTabId: "tab-2",
  tabOrder: ["tab-1", "tab-2"],
  tabs: [
    makeTab({
      id: "tab-1",
      index: 0,
      current: "https://google.com",
    }),
    makeTab({
      id: "tab-2",
      index: 1,
      current: "https://archestra.ai",
    }),
  ],
});

const unwrapOk = <E, T>(result: Result<E, T>): T => {
  if (result.tag !== "Ok") {
    throw new Error("Expected Ok result");
  }
  return result.value;
};

describe("browser state invariants", () => {
  test("validateBrowserState accepts a valid state", () => {
    const state = makeState();
    const result = validateBrowserState({ state });
    expect(result.tag).toBe("Ok");
  });

  test("validateBrowserState rejects missing active tab", () => {
    const state = { ...makeState(), activeTabId: "tab-3" };
    const result = validateBrowserState({ state });
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      expect(result.error.kind).toBe("ActiveTabMissing");
    }
  });

  test("validateBrowserState rejects duplicate indices", () => {
    const state = makeState();
    const updated = {
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.id === "tab-2" ? { ...tab, index: Some(0) } : tab,
      ),
    };
    const result = validateBrowserState({ state: updated });
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      expect(result.error.kind).toBe("DuplicateTabIndex");
      if (result.error.kind === "DuplicateTabIndex") {
        expect(result.error.indices).toContain(0);
      }
    }
  });
});

describe("browser state operations", () => {
  test("applyTabsList rebuilds indices and active tab", () => {
    const state = {
      ...makeState(),
      tabs: makeState().tabs.map((tab) => ({ ...tab, index: None })),
    };

    const result = applyTabsList({
      state,
      list: [
        { index: 2, isCurrent: false },
        { index: 4, isCurrent: true },
      ],
    });

    const updated = unwrapOk(result);
    const tab1 = updated.tabs.find((tab) => tab.id === "tab-1");
    const tab2 = updated.tabs.find((tab) => tab.id === "tab-2");

    expect(updated.activeTabId).toBe("tab-2");
    expect(tab1?.index).toEqual(Some(2));
    expect(tab2?.index).toEqual(Some(4));
  });

  test("applyTabsList rejects list length mismatches", () => {
    const state = makeState();
    const result = applyTabsList({
      state,
      list: [{ index: 0, isCurrent: true }],
    });

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      expect(result.error.kind).toBe("TabCountMismatch");
    }
  });

  test("applyTabsCreate adds a new tab and sets active", () => {
    const state = makeState();
    const result = applyTabsCreate({
      state,
      tabId: "tab-3",
      index: 2,
      initialUrl: "https://example.com",
    });

    const updated = unwrapOk(result);
    const newTab = updated.tabs.find((tab) => tab.id === "tab-3");

    expect(updated.activeTabId).toBe("tab-3");
    expect(updated.tabOrder).toEqual(["tab-1", "tab-2", "tab-3"]);
    expect(newTab?.index).toEqual(Some(2));
    expect(newTab?.current).toBe("https://example.com");
  });

  test("applyTabsClose removes the tab, reindexes, and reassigns active", () => {
    const state: BrowserState = {
      activeTabId: "tab-2",
      tabOrder: ["tab-1", "tab-2", "tab-3"],
      tabs: [
        makeTab({
          id: "tab-1",
          index: 0,
          current: "https://example.com",
        }),
        makeTab({
          id: "tab-2",
          index: 1,
          current: "https://example.com/2",
        }),
        makeTab({
          id: "tab-3",
          index: 2,
          current: "https://example.com/3",
        }),
      ],
    };

    const result = applyTabsClose({ state, index: 1 });
    const updated = unwrapOk(result);
    const tab3 = updated.tabs.find((tab) => tab.id === "tab-3");

    expect(updated.activeTabId).toBe("tab-3");
    expect(updated.tabOrder).toEqual(["tab-1", "tab-3"]);
    expect(tab3?.index).toEqual(Some(1));
  });

  test("applyTabsClose rejects closing the last tab", () => {
    const state: BrowserState = {
      activeTabId: "tab-1",
      tabOrder: ["tab-1"],
      tabs: [
        makeTab({
          id: "tab-1",
          index: 0,
          current: "https://example.com",
        }),
      ],
    };

    const result = applyTabsClose({ state, index: 0 });
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      expect(result.error.kind).toBe("CannotCloseLastTab");
    }
  });

  test("applyUpdateCurrentUrl updates the current URL for a tab", () => {
    const state = makeState();

    const result = applyUpdateCurrentUrl({
      state,
      tabId: "tab-1",
      url: "https://new-url.com",
    });

    const updated = unwrapOk(result);
    const tab1 = updated.tabs.find((tab) => tab.id === "tab-1");
    expect(tab1?.current).toBe("https://new-url.com");
  });

  test("applyUpdateCurrentUrl returns error for non-existent tab", () => {
    const state = makeState();

    const result = applyUpdateCurrentUrl({
      state,
      tabId: "non-existent",
      url: "https://new-url.com",
    });

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      expect(result.error.kind).toBe("TabNotFound");
    }
  });

  test("resolveIndexForTab returns error when index is missing", () => {
    const state = {
      ...makeState(),
      tabs: makeState().tabs.map((tab) =>
        tab.id === "tab-2" ? { ...tab, index: None } : tab,
      ),
    };

    const result = resolveIndexForTab({ state, tabId: "tab-2" });
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      expect(result.error.kind).toBe("TabIndexUnavailable");
    }
  });

  test("resolveTabIdForIndex resolves the logical tab id", () => {
    const state = makeState();
    const result = resolveTabIdForIndex({ state, index: 1 });
    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value).toBe("tab-2");
    }
  });
});
