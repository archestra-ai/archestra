import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import { beforeEach, describe, expect, test } from "@/test";

// Create a hoisted mock for the feature flag value
const mockBrowserStreamingEnabled = vi.hoisted(() => ({ value: false }));

// Mock config before importing the feature
vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      features: {
        ...actual.default.features,
        get browserStreamingEnabled() {
          return mockBrowserStreamingEnabled.value;
        },
      },
    },
  };
});

// Import after mocking (dynamic import needed because of the mock)
const { browserStreamFeature } = await import("./browser-stream.feature");

describe("BrowserStreamFeature", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockBrowserStreamingEnabled.value = false;
  });

  describe("isEnabled", () => {
    test("returns false when feature flag is disabled", () => {
      mockBrowserStreamingEnabled.value = false;
      expect(browserStreamFeature.isEnabled()).toBe(false);
    });

    test("returns true when feature flag is enabled", () => {
      mockBrowserStreamingEnabled.value = true;
      expect(browserStreamFeature.isEnabled()).toBe(true);
    });
  });

  describe("isBrowserWebSocketMessage", () => {
    test("returns true for browser stream subscription messages", () => {
      expect(
        browserStreamFeature.isBrowserWebSocketMessage(
          "subscribe_browser_stream",
        ),
      ).toBe(true);
      expect(
        browserStreamFeature.isBrowserWebSocketMessage(
          "unsubscribe_browser_stream",
        ),
      ).toBe(true);
    });

    test("returns true for browser navigation messages", () => {
      expect(
        browserStreamFeature.isBrowserWebSocketMessage("browser_navigate"),
      ).toBe(true);
      expect(
        browserStreamFeature.isBrowserWebSocketMessage("browser_navigate_back"),
      ).toBe(true);
    });

    test("returns true for browser interaction messages", () => {
      expect(
        browserStreamFeature.isBrowserWebSocketMessage("browser_click"),
      ).toBe(true);
      expect(
        browserStreamFeature.isBrowserWebSocketMessage("browser_type"),
      ).toBe(true);
      expect(
        browserStreamFeature.isBrowserWebSocketMessage("browser_press_key"),
      ).toBe(true);
    });

    test("returns true for browser snapshot messages", () => {
      expect(
        browserStreamFeature.isBrowserWebSocketMessage("browser_get_snapshot"),
      ).toBe(true);
    });

    test("returns true for browser zoom messages", () => {
      expect(
        browserStreamFeature.isBrowserWebSocketMessage("browser_set_zoom"),
      ).toBe(true);
    });

    test("returns false for non-browser messages", () => {
      expect(
        browserStreamFeature.isBrowserWebSocketMessage("hello-world"),
      ).toBe(false);
      expect(browserStreamFeature.isBrowserWebSocketMessage("error")).toBe(
        false,
      );
      expect(
        browserStreamFeature.isBrowserWebSocketMessage("some_other_message"),
      ).toBe(false);
      expect(browserStreamFeature.isBrowserWebSocketMessage("")).toBe(false);
    });
  });
});
