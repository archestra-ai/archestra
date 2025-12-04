import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the config module
vi.mock("@/lib/config", () => ({
  getBackendBaseUrl: vi.fn(() => "http://localhost:9000"),
}));

import { getBackendBaseUrl } from "@/lib/config";
import { DELETE, GET, PATCH, POST, PUT } from "./route";

describe("auth route handler", () => {
  const mockGetBackendBaseUrl = vi.mocked(getBackendBaseUrl);
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
    // Reset fetch mock
    global.fetch = vi.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const createMockRequest = (
    path: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      searchParams?: Record<string, string>;
    } = {},
  ) => {
    const url = new URL(path, "http://localhost:3000");
    if (options.searchParams) {
      for (const [key, value] of Object.entries(options.searchParams)) {
        url.searchParams.set(key, value);
      }
    }

    return new NextRequest(url, {
      method: options.method || "GET",
      headers: options.headers ? new Headers(options.headers) : undefined,
      body: options.body,
    });
  };

  const createMockResponse = (
    body: string | null,
    options: {
      status?: number;
      statusText?: string;
      headers?: Record<string, string>;
    } = {},
  ) => {
    return new Response(body, {
      status: options.status || 200,
      statusText: options.statusText || "OK",
      headers: options.headers ? new Headers(options.headers) : undefined,
    });
  };

  describe("request forwarding", () => {
    it("should forward GET requests to the backend", async () => {
      const mockResponse = createMockResponse('{"success": true}', {
        headers: { "Content-Type": "application/json" },
      });
      vi.mocked(global.fetch).mockResolvedValue(mockResponse);

      const request = createMockRequest("/api/auth/session");
      const params = { params: Promise.resolve({ path: ["session"] }) };

      const response = await GET(request, params);

      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:9000/api/auth/session",
        expect.objectContaining({
          method: "GET",
          redirect: "manual",
        }),
      );
      expect(response.status).toBe(200);
    });

    it("should forward POST requests with body to the backend", async () => {
      const mockResponse = createMockResponse('{"success": true}');
      vi.mocked(global.fetch).mockResolvedValue(mockResponse);

      const request = createMockRequest("/api/auth/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"email": "test@example.com"}',
      });
      const params = { params: Promise.resolve({ path: ["sign-in"] }) };

      await POST(request, params);

      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:9000/api/auth/sign-in",
        expect.objectContaining({
          method: "POST",
          body: '{"email": "test@example.com"}',
        }),
      );
    });

    it("should forward nested paths correctly", async () => {
      const mockResponse = createMockResponse("");
      vi.mocked(global.fetch).mockResolvedValue(mockResponse);

      const request = createMockRequest("/api/auth/sso/saml2/sp/acs/provider1");
      const params = {
        params: Promise.resolve({
          path: ["sso", "saml2", "sp", "acs", "provider1"],
        }),
      };

      await GET(request, params);

      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:9000/api/auth/sso/saml2/sp/acs/provider1",
        expect.anything(),
      );
    });

    it("should forward query parameters", async () => {
      const mockResponse = createMockResponse("");
      vi.mocked(global.fetch).mockResolvedValue(mockResponse);

      const request = createMockRequest("/api/auth/callback", {
        searchParams: { code: "abc123", state: "xyz789" },
      });
      const params = { params: Promise.resolve({ path: ["callback"] }) };

      await GET(request, params);

      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:9000/api/auth/callback?code=abc123&state=xyz789",
        expect.anything(),
      );
    });

    it("should use configured backend URL", async () => {
      mockGetBackendBaseUrl.mockReturnValue("https://api.example.com");
      const mockResponse = createMockResponse("");
      vi.mocked(global.fetch).mockResolvedValue(mockResponse);

      const request = createMockRequest("/api/auth/session");
      const params = { params: Promise.resolve({ path: ["session"] }) };

      await GET(request, params);

      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.example.com/api/auth/session",
        expect.anything(),
      );
    });
  });

  describe("header forwarding", () => {
    it("should forward request headers except Host", async () => {
      const mockResponse = createMockResponse("");
      vi.mocked(global.fetch).mockResolvedValue(mockResponse);

      const request = createMockRequest("/api/auth/session", {
        headers: {
          Host: "frontend.example.com",
          Cookie: "session=abc123",
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
        },
      });
      const params = { params: Promise.resolve({ path: ["session"] }) };

      await GET(request, params);

      const fetchCall = vi.mocked(global.fetch).mock.calls[0];
      const headers = fetchCall[1]?.headers as Headers;

      expect(headers.get("host")).toBeNull();
      expect(headers.get("cookie")).toBe("session=abc123");
      expect(headers.get("user-agent")).toBe("Mozilla/5.0");
      expect(headers.get("accept")).toBe("application/json");
    });

    it("should not forward content-encoding header from response", async () => {
      const mockResponse = createMockResponse('{"data": true}', {
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          "X-Custom-Header": "value",
        },
      });
      vi.mocked(global.fetch).mockResolvedValue(mockResponse);

      const request = createMockRequest("/api/auth/session");
      const params = { params: Promise.resolve({ path: ["session"] }) };

      const response = await GET(request, params);

      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("x-custom-header")).toBe("value");
    });
  });

  describe("SAML origin handling", () => {
    it("should replace null origin with frontend origin for SAML callbacks", async () => {
      const mockResponse = createMockResponse("");
      vi.mocked(global.fetch).mockResolvedValue(mockResponse);

      const request = createMockRequest("/api/auth/sso/saml2/sp/acs/provider", {
        method: "POST",
        headers: {
          Origin: "null",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "SAMLResponse=...",
      });
      const params = {
        params: Promise.resolve({
          path: ["sso", "saml2", "sp", "acs", "provider"],
        }),
      };

      await POST(request, params);

      const fetchCall = vi.mocked(global.fetch).mock.calls[0];
      const headers = fetchCall[1]?.headers as Headers;

      expect(headers.get("origin")).toBe("http://localhost:3000");
    });

    it("should replace missing origin with frontend origin", async () => {
      const mockResponse = createMockResponse("");
      vi.mocked(global.fetch).mockResolvedValue(mockResponse);

      const request = createMockRequest("/api/auth/sso/saml2/sp/acs/provider", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "SAMLResponse=...",
      });
      const params = {
        params: Promise.resolve({
          path: ["sso", "saml2", "sp", "acs", "provider"],
        }),
      };

      await POST(request, params);

      const fetchCall = vi.mocked(global.fetch).mock.calls[0];
      const headers = fetchCall[1]?.headers as Headers;

      expect(headers.get("origin")).toBe("http://localhost:3000");
    });

    it("should use custom frontend URL from env var", async () => {
      process.env.ARCHESTRA_FRONTEND_URL = "https://app.example.com";
      const mockResponse = createMockResponse("");
      vi.mocked(global.fetch).mockResolvedValue(mockResponse);

      const request = createMockRequest("/api/auth/sso/saml2/sp/acs/provider", {
        method: "POST",
        headers: {
          Origin: "null",
        },
        body: "SAMLResponse=...",
      });
      const params = {
        params: Promise.resolve({
          path: ["sso", "saml2", "sp", "acs", "provider"],
        }),
      };

      await POST(request, params);

      const fetchCall = vi.mocked(global.fetch).mock.calls[0];
      const headers = fetchCall[1]?.headers as Headers;

      expect(headers.get("origin")).toBe("https://app.example.com");
    });

    it("should preserve valid origin header", async () => {
      const mockResponse = createMockResponse("");
      vi.mocked(global.fetch).mockResolvedValue(mockResponse);

      const request = createMockRequest("/api/auth/session", {
        headers: {
          Origin: "https://valid-origin.com",
        },
      });
      const params = { params: Promise.resolve({ path: ["session"] }) };

      await GET(request, params);

      const fetchCall = vi.mocked(global.fetch).mock.calls[0];
      const headers = fetchCall[1]?.headers as Headers;

      expect(headers.get("origin")).toBe("https://valid-origin.com");
    });
  });

  describe("HTTP methods", () => {
    it("should handle PUT requests", async () => {
      const mockResponse = createMockResponse("");
      vi.mocked(global.fetch).mockResolvedValue(mockResponse);

      const request = createMockRequest("/api/auth/user", {
        method: "PUT",
        body: '{"name": "Test"}',
      });
      const params = { params: Promise.resolve({ path: ["user"] }) };

      await PUT(request, params);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: "PUT", body: '{"name": "Test"}' }),
      );
    });

    it("should handle DELETE requests", async () => {
      const mockResponse = createMockResponse("");
      vi.mocked(global.fetch).mockResolvedValue(mockResponse);

      const request = createMockRequest("/api/auth/session", {
        method: "DELETE",
      });
      const params = { params: Promise.resolve({ path: ["session"] }) };

      await DELETE(request, params);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("should handle PATCH requests", async () => {
      const mockResponse = createMockResponse("");
      vi.mocked(global.fetch).mockResolvedValue(mockResponse);

      const request = createMockRequest("/api/auth/user", {
        method: "PATCH",
        body: '{"name": "Updated"}',
      });
      const params = { params: Promise.resolve({ path: ["user"] }) };

      await PATCH(request, params);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: "PATCH",
          body: '{"name": "Updated"}',
        }),
      );
    });

    it("should not include body for GET requests", async () => {
      const mockResponse = createMockResponse("");
      vi.mocked(global.fetch).mockResolvedValue(mockResponse);

      const request = createMockRequest("/api/auth/session", {
        method: "GET",
      });
      const params = { params: Promise.resolve({ path: ["session"] }) };

      await GET(request, params);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: undefined }),
      );
    });
  });

  describe("response handling", () => {
    it("should preserve response status and statusText", async () => {
      const mockResponse = createMockResponse('{"error": "Not found"}', {
        status: 404,
        statusText: "Not Found",
      });
      vi.mocked(global.fetch).mockResolvedValue(mockResponse);

      const request = createMockRequest("/api/auth/nonexistent");
      const params = { params: Promise.resolve({ path: ["nonexistent"] }) };

      const response = await GET(request, params);

      expect(response.status).toBe(404);
      expect(response.statusText).toBe("Not Found");
    });

    it("should handle redirect responses without following", async () => {
      const mockResponse = createMockResponse(null, {
        status: 302,
        statusText: "Found",
        headers: { Location: "https://idp.example.com/login" },
      });
      vi.mocked(global.fetch).mockResolvedValue(mockResponse);

      const request = createMockRequest("/api/auth/sso/callback");
      const params = { params: Promise.resolve({ path: ["sso", "callback"] }) };

      const response = await GET(request, params);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://idp.example.com/login",
      );
    });
  });
});
