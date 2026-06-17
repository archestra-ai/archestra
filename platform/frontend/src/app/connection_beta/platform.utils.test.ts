import { afterEach, describe, expect, it, vi } from "vitest";
import { detectPlatform, toPlatformOption } from "./platform.utils";

function stubUserAgent(userAgent: string, platform = "") {
  vi.stubGlobal("navigator", { userAgent, platform });
}

describe("detectPlatform", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("detects Windows", () => {
    stubUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    );
    expect(detectPlatform()).toBe("windows");
  });

  it("detects macOS from a Macintosh UA", () => {
    stubUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    );
    expect(detectPlatform()).toBe("macos");
  });

  it("treats darwin as macOS, not Windows (darwin contains 'win')", () => {
    stubUserAgent("Mozilla/5.0 (darwin) AppleWebKit/537.36 jsdom/29.0.0");
    expect(detectPlatform()).toBe("macos");
  });

  it("detects Linux", () => {
    stubUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36");
    expect(detectPlatform()).toBe("linux");
  });

  it("falls back to macOS when nothing matches", () => {
    stubUserAgent("something-unknown");
    expect(detectPlatform()).toBe("macos");
  });
});

describe("toPlatformOption", () => {
  it("folds linux into the macOS/Linux bash option", () => {
    expect(toPlatformOption("linux")).toBe("macos");
    expect(toPlatformOption("macos")).toBe("macos");
  });

  it("keeps windows distinct", () => {
    expect(toPlatformOption("windows")).toBe("windows");
  });
});
