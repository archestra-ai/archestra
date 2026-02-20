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

    it("should handle paths with URL fragments", () => {
      expect(getValidatedRedirectPath(encodeURIComponent("/docs#api"))).toBe(
        "/docs#api",
      );
      expect(
        getValidatedRedirectPath(encodeURIComponent("/page#section-2")),
      ).toBe("/page#section-2");
      expect(
        getValidatedRedirectPath(
          encodeURIComponent("/docs?tab=overview#getting-started"),
        ),
      ).toBe("/docs?tab=overview#getting-started");
    });

    it("should allow path traversal sequences (browser normalizes safely)", () => {
      // Path traversal is allowed because:
      // 1. These are client-side redirects, not file system access
      // 2. Browser normalizes /../ to stay within the origin
      // 3. /../../etc/passwd becomes /etc/passwd which is still within the app
      expect(getValidatedRedirectPath(encodeURIComponent("/../foo"))).toBe(
        "/../foo",
      );
      expect(
        getValidatedRedirectPath(encodeURIComponent("/../../etc/passwd")),
      ).toBe("/../../etc/passwd");
      expect(getValidatedRedirectPath(encodeURIComponent("/foo/../bar"))).toBe(
        "/foo/../bar",
      );
    });

    it("should reject double-encoded paths that don't start with /", () => {
      // Double-encoded slash: %252F decodes to %2F (literal characters, not /)
      // Since %2F doesn't start with /, it's rejected - this is safe behavior
      expect(getValidatedRedirectPath("%252Fdashboard")).toBe("/");
      // Even valid-looking double-encoded paths are rejected if they don't
      // decode to start with /
      expect(getValidatedRedirectPath("%252F%252Fdashboard")).toBe("/");
    });

    it("should allow paths with encoded characters after the leading /", () => {
      // A path starting with / followed by encoded characters is valid
      // e.g., /dashboard%2Fsubpath decodes to /dashboard%2Fsubpath
      expect(getValidatedRedirectPath("%2Fdashboard%252Fsubpath")).toBe(
        "/dashboard%2Fsubpath",
      );
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

    it("should reject javascript: protocol URLs", () => {
      expect(
        getValidatedRedirectPath(encodeURIComponent("javascript:alert(1)")),
      ).toBe("/");
      expect(
        getValidatedRedirectPath(
          encodeURIComponent("javascript:document.cookie"),
        ),
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

    it("should reject paths with backslashes in the path portion", () => {
      // Some browsers normalize backslashes to forward slashes
      // /\evil.com could become //evil.com (protocol-relative URL)
      expect(getValidatedRedirectPath(encodeURIComponent("/\\evil.com"))).toBe(
        "/",
      );
      expect(getValidatedRedirectPath(encodeURIComponent("/foo\\bar"))).toBe(
        "/",
      );
      expect(
        getValidatedRedirectPath(encodeURIComponent("/path\\\\to\\file")),
      ).toBe("/");
    });

    it("should allow backslashes in query parameter values", () => {
      // Backslashes in query params are just data, not part of the path
      expect(
        getValidatedRedirectPath(
          encodeURIComponent("/page?path=C:\\Users\\file"),
        ),
      ).toBe("/page?path=C:\\Users\\file");
    });

    it("should reject paths with :// in the path portion", () => {
      expect(
        getValidatedRedirectPath(encodeURIComponent("https://evil.com/path")),
      ).toBe("/");
      expect(
        getValidatedRedirectPath(encodeURIComponent("/https://evil.com")),
      ).toBe("/");
    });

    it("should allow paths with :// in query parameter values", () => {
      // Protocol URLs in query params are just data, not redirect targets.
      // This is critical for OAuth flows where redirect_uri contains protocol URLs
      // (e.g., cursor://anysphere.cursor-mcp/oauth/callback)
      expect(
        getValidatedRedirectPath(
          encodeURIComponent("/redirect?url=https://evil.com"),
        ),
      ).toBe("/redirect?url=https://evil.com");
      expect(
        getValidatedRedirectPath(
          encodeURIComponent(
            "/oauth/consent?redirect_uri=cursor://app/callback&scope=mcp",
          ),
        ),
      ).toBe("/oauth/consent?redirect_uri=cursor://app/callback&scope=mcp");
    });

    it("should handle OAuth consent redirect with complex query params", () => {
      // Simulates the real OAuth flow: sign-in redirectTo contains the full
      // consent URL with encoded redirect_uri containing a custom protocol
      const consentUrl =
        "/oauth/consent?response_type=code&client_id=abc&redirect_uri=cursor%3A%2F%2Fapp%2Fcallback&scope=mcp&code_challenge=xyz&code_challenge_method=S256";
      // After searchParams.get() decodes once, we pass the decoded value.
      // getValidatedRedirectPath decodes again, revealing cursor:// in query params.
      // This should still be accepted since :// is only in query params, not the path.
      expect(getValidatedRedirectPath(encodeURIComponent(consentUrl))).toBe(
        consentUrl,
      );
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
