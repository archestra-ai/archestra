import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getValidatedCallbackURLWithDefault,
  getValidatedRedirectPath,
} from "./redirect-validation";

describe("redirect-validation", () => {
  const mockOrigin = "https://app.archestra.io";

  beforeEach(() => {
    // Mock window.location.origin
    vi.stubGlobal("window", {
      location: { origin: mockOrigin },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("getValidatedRedirectPath", () => {
    it("should return / when redirectTo is null", () => {
      expect(getValidatedRedirectPath(null)).toBe("/");
    });

    it("should return / when redirectTo is empty string", () => {
      expect(getValidatedRedirectPath("")).toBe("/");
    });

    it("should decode and return valid relative paths", () => {
      expect(getValidatedRedirectPath("%2Fdashboard")).toBe("/dashboard");
      expect(getValidatedRedirectPath("%2Fsettings%2Fteams%2F123")).toBe(
        "/settings/teams/123",
      );
      expect(getValidatedRedirectPath("%2Flogs%2Fllm-proxy")).toBe(
        "/logs/llm-proxy",
      );
    });

    it("should handle paths with query parameters", () => {
      expect(
        getValidatedRedirectPath("%2Fsearch%3Fq%3Dhello%26filter%3Dactive"),
      ).toBe("/search?q=hello&filter=active");
    });

    it("should return / for malformed URI encoding", () => {
      // %ZZ is invalid percent encoding
      expect(getValidatedRedirectPath("%ZZ")).toBe("/");
      // %2 is incomplete percent encoding
      expect(getValidatedRedirectPath("%2")).toBe("/");
    });

    it("should reject absolute URLs with protocol", () => {
      expect(
        getValidatedRedirectPath(encodeURIComponent("https://evil.com")),
      ).toBe("/");
      expect(
        getValidatedRedirectPath(
          encodeURIComponent("https://evil.com/phishing"),
        ),
      ).toBe("/");
      expect(
        getValidatedRedirectPath(encodeURIComponent("http://evil.com")),
      ).toBe("/");
    });

    it("should reject protocol-relative URLs", () => {
      expect(getValidatedRedirectPath(encodeURIComponent("//evil.com"))).toBe(
        "/",
      );
      expect(
        getValidatedRedirectPath(encodeURIComponent("//evil.com/path")),
      ).toBe("/");
    });

    it("should reject paths containing ://", () => {
      expect(
        getValidatedRedirectPath(
          encodeURIComponent("/redirect?url=https://evil.com"),
        ),
      ).toBe("/");
    });

    it("should reject paths not starting with /", () => {
      expect(getValidatedRedirectPath(encodeURIComponent("dashboard"))).toBe(
        "/",
      );
      expect(
        getValidatedRedirectPath(encodeURIComponent("evil.com/path")),
      ).toBe("/");
    });
  });

  describe("getValidatedCallbackURLWithDefault", () => {
    it("should return home URL when redirectTo is null", () => {
      expect(getValidatedCallbackURLWithDefault(null)).toBe(`${mockOrigin}/`);
    });

    it("should return home URL when redirectTo is empty string", () => {
      expect(getValidatedCallbackURLWithDefault("")).toBe(`${mockOrigin}/`);
    });

    it("should return full URL for valid relative paths", () => {
      expect(getValidatedCallbackURLWithDefault("%2Fdashboard")).toBe(
        `${mockOrigin}/dashboard`,
      );
    });

    it("should return home URL for malformed encoding", () => {
      expect(getValidatedCallbackURLWithDefault("%ZZ")).toBe(`${mockOrigin}/`);
    });

    it("should return home URL for malicious URLs", () => {
      expect(
        getValidatedCallbackURLWithDefault(
          encodeURIComponent("https://evil.com"),
        ),
      ).toBe(`${mockOrigin}/`);
      expect(
        getValidatedCallbackURLWithDefault(encodeURIComponent("//evil.com")),
      ).toBe(`${mockOrigin}/`);
    });
  });
});
