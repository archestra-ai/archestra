import { describe, expect, test } from "@/test";
import {
  applyBack,
  applyForward,
  applyNavigate,
  applyTabsClose,
  applyTabsCreate,
  applyTabsList,
  resolveIndexForTab,
  resolveTabIdForIndex,
} from "./browser-stream.state";
import {
  type BrowserState,
  type BrowserTabState,
  type NonEmptyArray,
  None,
  type Result,
  Some,
} from "./browser-stream.state.types";
import { validateBrowserState } from "./browser-stream.state.validation";

const makeHistory = (
  first: string,
  ...rest: string[]
): NonEmptyArray<string> => [first, ...rest];

const makeTab = (params: {
  id: string;
  index: number | null;
  history: NonEmptyArray<string>;
  historyCursor: number;
}): BrowserTabState => ({
  id: params.id,
  index: params.index === null ? None : Some(params.index),
  current: params.history[params.historyCursor],
  history: params.history,
  historyCursor: params.historyCursor,
});

const makeState = (): BrowserState => ({
  activeTabId: "tab-2",
  tabOrder: ["tab-1", "tab-2"],
  tabs: [
    makeTab({
      id: "tab-1",
      index: 0,
      history: makeHistory("https://google.com"),
      historyCursor: 0,
    }),
    makeTab({
      id: "tab-2",
      index: 1,
      history: makeHistory("https://google.com", "https://archestra.ai"),
      historyCursor: 1,
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

  test("validateBrowserState rejects history cursor out of bounds", () => {
    const state = makeState();
    const updated = {
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.id === "tab-2" ? { ...tab, historyCursor: 9 } : tab,
      ),
    };
    const result = validateBrowserState({ state: updated });
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      expect(result.error.kind).toBe("HistoryCursorOutOfBounds");
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
    expect(newTab?.history).toEqual(["https://example.com"]);
    expect(newTab?.historyCursor).toBe(0);
  });

  test("applyTabsClose removes the tab, reindexes, and reassigns active", () => {
    const state: BrowserState = {
      activeTabId: "tab-2",
      tabOrder: ["tab-1", "tab-2", "tab-3"],
      tabs: [
        makeTab({
          id: "tab-1",
          index: 0,
          history: makeHistory("https://example.com"),
          historyCursor: 0,
        }),
        makeTab({
          id: "tab-2",
          index: 1,
          history: makeHistory("https://example.com/2"),
          historyCursor: 0,
        }),
        makeTab({
          id: "tab-3",
          index: 2,
          history: makeHistory("https://example.com/3"),
          historyCursor: 0,
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
          history: makeHistory("https://example.com"),
          historyCursor: 0,
        }),
      ],
    };

    const result = applyTabsClose({ state, index: 0 });
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      expect(result.error.kind).toBe("CannotCloseLastTab");
    }
  });

  test("applyNavigate truncates forward history", () => {
    const state: BrowserState = {
      activeTabId: "tab-1",
      tabOrder: ["tab-1"],
      tabs: [
        makeTab({
          id: "tab-1",
          index: 0,
          history: makeHistory("a", "b", "c"),
          historyCursor: 1,
        }),
      ],
    };

    const result = applyNavigate({
      state,
      tabId: "tab-1",
      url: "d",
    });

    const updated = unwrapOk(result);
    const tab = updated.tabs[0];
    expect(tab.history).toEqual(["a", "b", "d"]);
    expect(tab.historyCursor).toBe(2);
    expect(tab.current).toBe("d");
  });

  test("applyBack updates cursor and returns navigation effect", () => {
    const state: BrowserState = {
      activeTabId: "tab-1",
      tabOrder: ["tab-1"],
      tabs: [
        makeTab({
          id: "tab-1",
          index: 0,
          history: makeHistory("a", "b"),
          historyCursor: 1,
        }),
      ],
    };

    const result = applyBack({ state, tabId: "tab-1" });
    const updated = unwrapOk(result);

    expect(updated.effect).toEqual({
      tag: "Navigate",
      tabId: "tab-1",
      url: "a",
    });
    expect(updated.state.tabs[0].historyCursor).toBe(0);
    expect(updated.state.tabs[0].current).toBe("a");
  });

  test("applyForward updates cursor and returns navigation effect", () => {
    const state: BrowserState = {
      activeTabId: "tab-1",
      tabOrder: ["tab-1"],
      tabs: [
        makeTab({
          id: "tab-1",
          index: 0,
          history: makeHistory("a", "b"),
          historyCursor: 0,
        }),
      ],
    };

    const result = applyForward({ state, tabId: "tab-1" });
    const updated = unwrapOk(result);

    expect(updated.effect).toEqual({
      tag: "Navigate",
      tabId: "tab-1",
      url: "b",
    });
    expect(updated.state.tabs[0].historyCursor).toBe(1);
    expect(updated.state.tabs[0].current).toBe("b");
  });

  test("applyForward rejects when no forward history", () => {
    const state: BrowserState = {
      activeTabId: "tab-1",
      tabOrder: ["tab-1"],
      tabs: [
        makeTab({
          id: "tab-1",
          index: 0,
          history: makeHistory("a"),
          historyCursor: 0,
        }),
      ],
    };

    const result = applyForward({ state, tabId: "tab-1" });
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      expect(result.error.kind).toBe("NoForwardHistory");
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
