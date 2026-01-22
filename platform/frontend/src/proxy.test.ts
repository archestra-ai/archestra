import { NextRequest } from "next/server";
import { proxy } from "./proxy";

/**
 * Helper to create a mock NextRequest
 */
function createMockRequest(options: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
}): NextRequest {
  const { method = "GET", url, headers = {} } = options;
  const request = new NextRequest(new URL(url, "http://localhost:3000"), {
    method,
    headers: new Headers(headers),
  });
  return request;
}

describe("proxy", () => {
  const originalEnv = {
    ARCHESTRA_FRONTEND_URL: process.env.ARCHESTRA_FRONTEND_URL,
    ARCHESTRA_INTERNAL_API_BASE_URL:
      process.env.ARCHESTRA_INTERNAL_API_BASE_URL,
  };

  beforeEach(() => {
    // Reset env vars before each test
    delete process.env.ARCHESTRA_FRONTEND_URL;
    delete process.env.ARCHESTRA_INTERNAL_API_BASE_URL;
    // Suppress console.log during tests
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore original env vars
    if (originalEnv.ARCHESTRA_FRONTEND_URL) {
      process.env.ARCHESTRA_FRONTEND_URL = originalEnv.ARCHESTRA_FRONTEND_URL;
    } else {
      delete process.env.ARCHESTRA_FRONTEND_URL;
    }
    if (originalEnv.ARCHESTRA_INTERNAL_API_BASE_URL) {
      process.env.ARCHESTRA_INTERNAL_API_BASE_URL =
        originalEnv.ARCHESTRA_INTERNAL_API_BASE_URL;
    } else {
      delete process.env.ARCHESTRA_INTERNAL_API_BASE_URL;
    }
    vi.restoreAllMocks();
  });

  describe("regular requests", () => {
    it("should pass through regular GET requests", () => {
      const request = createMockRequest({
        method: "GET",
        url: "/api/profiles",
      });

      const response = proxy(request);

      // NextResponse.next() returns a response that continues the middleware chain
      expect(response.headers.get("x-middleware-next")).toBe("1");
    });

    it("should pass through regular POST requests", () => {
      const request = createMockRequest({
        method: "POST",
        url: "/api/profiles",
        headers: { Origin: "http://localhost:3000" },
      });

      const response = proxy(request);

      expect(response.headers.get("x-middleware-next")).toBe("1");
    });

    it("should pass through non-API requests", () => {
      const request = createMockRequest({
        method: "GET",
        url: "/settings",
      });

      const response = proxy(request);

      expect(response.headers.get("x-middleware-next")).toBe("1");
    });
  });

  describe("SAML callback handling", () => {
    it("should rewrite SAML callback with null origin", () => {
      const request = createMockRequest({
        method: "POST",
        url: "/api/auth/sso/saml2/sp/acs/MyProvider",
        headers: { Origin: "null" },
      });

      const response = proxy(request);

      // Should be a rewrite response (not next())
      expect(response.headers.get("x-middleware-next")).toBeNull();
      // Should rewrite to backend URL
      expect(response.headers.get("x-middleware-rewrite")).toContain(
        "localhost:9000",
      );
    });

    it("should rewrite SAML callback with missing origin", () => {
      const request = createMockRequest({
        method: "POST",
        url: "/api/auth/sso/saml2/sp/acs/MyProvider",
        // No Origin header
      });

      const response = proxy(request);

      expect(response.headers.get("x-middleware-next")).toBeNull();
      expect(response.headers.get("x-middleware-rewrite")).toContain(
        "localhost:9000",
      );
    });

    it("should pass through SAML callback with valid origin", () => {
      const request = createMockRequest({
        method: "POST",
        url: "/api/auth/sso/saml2/sp/acs/MyProvider",
        headers: { Origin: "http://localhost:3000" },
      });

      const response = proxy(request);

      // Should pass through (not rewrite)
      expect(response.headers.get("x-middleware-next")).toBe("1");
    });

    it("should not intercept GET requests to SAML paths", () => {
      const request = createMockRequest({
        method: "GET",
        url: "/api/auth/sso/saml2/sp/acs/MyProvider",
        headers: { Origin: "null" },
      });

      const response = proxy(request);

      // GET requests should pass through even with null origin
      expect(response.headers.get("x-middleware-next")).toBe("1");
    });

    it("should not intercept non-ACS SAML paths", () => {
      const request = createMockRequest({
        method: "POST",
        url: "/api/auth/sso/saml2/metadata",
        headers: { Origin: "null" },
      });

      const response = proxy(request);

      // Non-ACS paths should pass through
      expect(response.headers.get("x-middleware-next")).toBe("1");
    });

    it("should preserve query parameters in rewrite", () => {
      const request = createMockRequest({
        method: "POST",
        url: "/api/auth/sso/saml2/sp/acs/MyProvider?state=abc123&RelayState=xyz",
        headers: { Origin: "null" },
      });

      const response = proxy(request);

      const rewriteUrl = response.headers.get("x-middleware-rewrite");
      expect(rewriteUrl).toContain("state=abc123");
      expect(rewriteUrl).toContain("RelayState=xyz");
    });

    it("should use custom frontend URL from env var", () => {
      process.env.ARCHESTRA_FRONTEND_URL = "https://app.example.com";

      const request = createMockRequest({
        method: "POST",
        url: "/api/auth/sso/saml2/sp/acs/MyProvider",
        headers: { Origin: "null" },
      });

      const response = proxy(request);

      // The rewrite should happen with the custom frontend origin
      expect(response.headers.get("x-middleware-next")).toBeNull();
    });

    it("should use custom backend URL from env var", () => {
      process.env.ARCHESTRA_INTERNAL_API_BASE_URL = "https://api.example.com";

      const request = createMockRequest({
        method: "POST",
        url: "/api/auth/sso/saml2/sp/acs/MyProvider",
        headers: { Origin: "null" },
      });

      const response = proxy(request);

      expect(response.headers.get("x-middleware-rewrite")).toContain(
        "api.example.com",
      );
    });
  });

  describe("API request logging", () => {
    it("should log /api requests", () => {
      const consoleSpy = vi.spyOn(console, "log");
      const request = createMockRequest({
        method: "GET",
        url: "/api/profiles",
      });

      proxy(request);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("API Request: GET"),
      );
    });

    it("should log /v1 requests", () => {
      const consoleSpy = vi.spyOn(console, "log");
      const request = createMockRequest({
        method: "POST",
        url: "/v1/chat/completions",
      });

      proxy(request);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("API Request: POST"),
      );
    });

    it("should not log /_next requests", () => {
      const consoleSpy = vi.spyOn(console, "log");
      const request = createMockRequest({
        method: "GET",
        url: "/_next/static/chunk.js",
      });

      proxy(request);

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("should not log non-API requests", () => {
      const consoleSpy = vi.spyOn(console, "log");
      const request = createMockRequest({
        method: "GET",
        url: "/settings",
      });

      proxy(request);

      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });
});
