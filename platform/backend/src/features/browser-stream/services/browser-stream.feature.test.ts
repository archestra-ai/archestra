import { describe, expect, test } from "@/test";
import { browserStreamFeature } from "./browser-stream.feature";

describe("BrowserStreamFeature", () => {
  describe("isEnabled", () => {
    test("returns true", () => {
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
