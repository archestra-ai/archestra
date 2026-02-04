import { describe, expect, it } from "vitest";
import {
  createInitialState,
  generateTabId,
  toPersistedState,
  toRuntimeState,
} from "./browser-stream.state.conversion";
import { isSome } from "./browser-stream.state.helpers";
import type {
  BrowserState,
  BrowserTabState,
  PersistedBrowserState,
} from "./browser-stream.state.types";
import { None, Some } from "./browser-stream.state.types";

describe("browser-stream.state.conversion", () => {
  describe("generateTabId", () => {
    it("should generate a unique UUID", () => {
      const id1 = generateTabId();
      const id2 = generateTabId();

      expect(id1).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(id2).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(id1).not.toBe(id2);
    });
  });

  describe("createInitialState", () => {
    it("should create initial state with one tab", () => {
      const tabId = "test-tab-id";
      const url = "https://example.com";

      const state = createInitialState(tabId, url);

      expect(state.activeTabId).toBe(tabId);
      expect(state.tabOrder).toEqual([tabId]);
      expect(state.tabs).toHaveLength(1);

      const tab = state.tabs[0];
      expect(tab.id).toBe(tabId);
      expect(tab.index).toEqual(None);
      expect(tab.current).toBe(url);
    });
  });

  describe("toPersistedState", () => {
    it("should convert runtime state to persisted state", () => {
      const tab: BrowserTabState = {
        id: "tab-1",
        index: Some(0),
        current: "https://example.com",
      };

      const runtime: BrowserState = {
        activeTabId: "tab-1",
        tabOrder: ["tab-1"],
        tabs: [tab],
      };

      const persisted = toPersistedState(runtime);

      expect(persisted.activeTabId).toBe("tab-1");
      expect(persisted.tabOrder).toEqual(["tab-1"]);
      expect(persisted.tabs).toHaveProperty("tab-1");
      expect(persisted.tabs["tab-1"]).toEqual({
        current: "https://example.com",
      });
    });

    it("should convert multiple tabs", () => {
      const tab1: BrowserTabState = {
        id: "tab-1",
        index: Some(0),
        current: "https://example.com",
      };

      const tab2: BrowserTabState = {
        id: "tab-2",
        index: Some(1),
        current: "https://google.com/search",
      };

      const runtime: BrowserState = {
        activeTabId: "tab-2",
        tabOrder: ["tab-1", "tab-2"],
        tabs: [tab1, tab2],
      };

      const persisted = toPersistedState(runtime);

      expect(persisted.activeTabId).toBe("tab-2");
      expect(persisted.tabOrder).toEqual(["tab-1", "tab-2"]);
      expect(Object.keys(persisted.tabs)).toHaveLength(2);
      expect(persisted.tabs["tab-2"].current).toBe("https://google.com/search");
    });
  });

  describe("toRuntimeState", () => {
    it("should convert persisted state to runtime state", () => {
      const persisted: PersistedBrowserState = {
        activeTabId: "tab-1",
        tabOrder: ["tab-1"],
        tabs: {
          "tab-1": {
            current: "https://example.com",
          },
        },
      };

      const runtime = toRuntimeState(persisted);

      expect(runtime.activeTabId).toBe("tab-1");
      expect(runtime.tabOrder).toEqual(["tab-1"]);
      expect(runtime.tabs).toHaveLength(1);

      const tab = runtime.tabs[0];
      expect(tab.id).toBe("tab-1");
      expect(tab.index).toEqual(None);
      expect(tab.current).toBe("https://example.com");
    });

    it("should preserve tab order when converting", () => {
      const persisted: PersistedBrowserState = {
        activeTabId: "tab-2",
        tabOrder: ["tab-1", "tab-2", "tab-3"],
        tabs: {
          "tab-1": {
            current: "https://a.com",
          },
          "tab-2": {
            current: "https://b.com",
          },
          "tab-3": {
            current: "https://c.com",
          },
        },
      };

      const runtime = toRuntimeState(persisted);

      expect(runtime.tabs.map((t) => t.id)).toEqual([
        "tab-1",
        "tab-2",
        "tab-3",
      ]);
    });
  });

  describe("roundtrip conversion", () => {
    it("should preserve data through runtime -> persisted -> runtime", () => {
      const tabId = generateTabId();
      const original = createInitialState(tabId, "https://example.com");

      const persisted = toPersistedState(original);
      const restored = toRuntimeState(persisted);

      expect(restored.activeTabId).toBe(original.activeTabId);
      expect(restored.tabOrder).toEqual(original.tabOrder);
      expect(restored.tabs).toHaveLength(original.tabs.length);

      const restoredTab = restored.tabs[0];
      const originalTab = original.tabs[0];

      expect(restoredTab.id).toBe(originalTab.id);
      expect(restoredTab.current).toBe(originalTab.current);
      // Index is not persisted, so both should be None
      expect(isSome(restoredTab.index)).toBe(false);
    });
  });
});
