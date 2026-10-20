// @vitest-environment node
import { NextRequest } from "next/server";
import { SHELL_SEED_ROUTES } from "./lib/auth/shell-seed";
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

  describe("root redirect", () => {
    it("should redirect / to /chat", () => {
      const request = createMockRequest({
        method: "GET",
        url: "/",
      });

      const response = proxy(request);

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain("/chat");
    });
  });

  describe("server-rendered first page marker", () => {
    const forwarded = (response: Response) =>
      response.headers.get("x-middleware-request-x-archestra-shell-seed");
    // The request headers the proxy hands on; a stripped header is missing.
    const handedOn = (response: Response) =>
      (response.headers.get("x-middleware-override-headers") ?? "").split(",");
    const documentLoad = { "sec-fetch-dest": "document" };

    it("hands on the query string of a marked document, and of no other", () => {
      const marked = proxy(
        createMockRequest({ url: "/chat?agentId=a1", headers: documentLoad }),
      );
      expect(
        new Headers(
          Object.fromEntries(
            handedOn(marked).map((name) => [
              name,
              marked.headers.get(`x-middleware-request-${name}`) ?? "",
            ]),
          ),
        ).get("x-archestra-shell-seed-search"),
      ).toBe("?agentId=a1");

      const unmarked = proxy(
        createMockRequest({
          url: "/agents?x=1",
          headers: {
            ...documentLoad,
            "x-archestra-shell-seed-search": "?forged=1",
          },
        }),
      );
      expect(handedOn(unmarked)).not.toContain("x-archestra-shell-seed-search");
    });

    it("marks a document load of the registry list", () => {
      expect(
        forwarded(
          proxy(
            createMockRequest({
              url: "/mcp/registry?page=2",
              headers: documentLoad,
            }),
          ),
        ),
      ).toBe("/mcp/registry");
    });

    it("marks the documents of every seeded route, and only those", () => {
      // Reads the list as it is, so a page added to it is covered here too.
      for (const route of SHELL_SEED_ROUTES) {
        expect(
          forwarded(
            proxy(createMockRequest({ url: route, headers: documentLoad })),
          ),
        ).toBe(route);
      }
      // An existing conversation, by its id.
      const conversation = "/chat/0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
      expect(
        forwarded(
          proxy(
            createMockRequest({ url: conversation, headers: documentLoad }),
          ),
        ),
      ).toBe(conversation);
      for (const url of [
        "/agents",
        "/mcp/gateways",
        "/mcp/registry/abc",
        // Not a conversation id, nor a page under one.
        "/chat/abc",
        "/chat/new",
        "/chat/runs/0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
        "/chat/0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/files",
      ]) {
        expect(
          forwarded(proxy(createMockRequest({ url, headers: documentLoad }))),
        ).toBeNull();
      }
    });

    it("does not mark a client navigation or route prefetch", () => {
      // What the proxy sees of a router fetch: Next has already removed the
      // flight headers, and the browser marks the fetch as not a document.
      const response = proxy(
        createMockRequest({
          url: "/mcp/registry",
          headers: {
            "sec-fetch-dest": "empty",
            "x-archestra-shell-seed": "/mcp/registry",
          },
        }),
      );

      expect(forwarded(response)).toBeNull();
      expect(handedOn(response)).not.toContain("x-archestra-shell-seed");
    });

    it("does not mark a request without Fetch Metadata", () => {
      expect(
        forwarded(proxy(createMockRequest({ url: "/mcp/registry" }))),
      ).toBeNull();
    });

    it("never hands on a client's own marker", () => {
      for (const request of [
        { url: "/mcp/registry", headers: documentLoad },
        { url: "/mcp/registry", headers: { "sec-fetch-dest": "empty" } },
        { url: "/agents", headers: documentLoad },
        { url: "/agents", headers: {} },
      ]) {
        const response = proxy(
          createMockRequest({
            url: request.url,
            headers: {
              ...request.headers,
              "x-archestra-shell-seed": "/forged",
            },
          }),
        );

        expect(forwarded(response)).not.toBe("/forged");
        if (request.url === "/agents") {
          expect(handedOn(response)).not.toContain("x-archestra-shell-seed");
        }
      }
    });
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
        "127.0.0.1:9000",
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
        "127.0.0.1:9000",
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

    it("should not log GET requests to /v1/mcp/ gateway polling", () => {
      const consoleSpy = vi.spyOn(console, "log");
      const request = createMockRequest({
        method: "GET",
        url: "/v1/mcp/some-profile-id",
      });

      proxy(request);

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("should still log POST requests to /v1/mcp/", () => {
      const consoleSpy = vi.spyOn(console, "log");
      const request = createMockRequest({
        method: "POST",
        url: "/v1/mcp/some-profile-id",
      });

      proxy(request);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("API Request: POST"),
      );
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

  describe("forwarded origin headers", () => {
    it("injects X-Forwarded-Host/Proto for backend-proxied paths", () => {
      const request = createMockRequest({
        method: "GET",
        url: "/.well-known/oauth-protected-resource/v1/mcp/profile-1",
        headers: { host: "localhost:3000" },
      });

      const response = proxy(request);

      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(
        response.headers.get("x-middleware-request-x-forwarded-host"),
      ).toBe("localhost:3000");
      expect(
        response.headers.get("x-middleware-request-x-forwarded-proto"),
      ).toBe("http");
    });

    it("injects forwarded host for /v1 and /api paths", () => {
      for (const url of ["/v1/mcp/profile-1", "/api/auth/jwks"]) {
        const response = proxy(
          createMockRequest({ url, headers: { host: "localhost:3000" } }),
        );

        expect(
          response.headers.get("x-middleware-request-x-forwarded-host"),
        ).toBe("localhost:3000");
      }
    });

    it("preserves X-Forwarded-Host/Proto set by an upstream proxy", () => {
      const request = createMockRequest({
        method: "GET",
        url: "/v1/mcp/profile-1",
        headers: {
          host: "localhost:3000",
          "x-forwarded-host": "app.example.com",
          "x-forwarded-proto": "https",
        },
      });

      const response = proxy(request);

      expect(
        response.headers.get("x-middleware-request-x-forwarded-host"),
      ).toBe("app.example.com");
      expect(
        response.headers.get("x-middleware-request-x-forwarded-proto"),
      ).toBe("https");
    });

    it("does not inject forwarded headers for non-proxied paths", () => {
      const request = createMockRequest({
        method: "GET",
        url: "/settings",
        headers: { host: "localhost:3000" },
      });

      const response = proxy(request);

      expect(
        response.headers.get("x-middleware-request-x-forwarded-host"),
      ).toBeNull();
    });
  });
});
