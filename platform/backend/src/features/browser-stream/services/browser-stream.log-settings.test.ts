import { describe, expect, it } from "vitest";
import { parseBrowserStreamLogSettings } from "./browser-stream.log-settings";

describe("browser-stream.log-settings", () => {
  it("defaults screenshot and tab sync logs to disabled", () => {
    const settings = parseBrowserStreamLogSettings({});

    expect(settings).toEqual({
      logScreenshots: false,
      logTabSync: false,
    });
  });

  it("enables logs when flags are true", () => {
    const settings = parseBrowserStreamLogSettings({
      ARCHESTRA_BROWSER_STREAM_LOG_SCREENSHOTS: "true",
      ARCHESTRA_BROWSER_STREAM_LOG_TAB_SYNC: "true",
    });

    expect(settings).toEqual({
      logScreenshots: true,
      logTabSync: true,
    });
  });

  it("treats non-true values as disabled", () => {
    const settings = parseBrowserStreamLogSettings({
      ARCHESTRA_BROWSER_STREAM_LOG_SCREENSHOTS: "TRUE",
      ARCHESTRA_BROWSER_STREAM_LOG_TAB_SYNC: "false",
    });

    expect(settings).toEqual({
      logScreenshots: false,
      logTabSync: false,
    });
  });
});
