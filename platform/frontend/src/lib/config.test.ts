import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock next-runtime-env
vi.mock("next-runtime-env", () => ({
  env: vi.fn((key: string) => process.env[key]),
}));

import {
  _getExternalBaseUrl,
  getBackendBaseUrl,
  getExternalProxyUrl,
  getWebSocketUrl,
} from "./config";

describe("getBackendBaseUrl", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return default localhost URL when no env vars are set", () => {
    delete process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL;
    delete process.env.ARCHESTRA_API_BASE_URL;

    const result = getBackendBaseUrl();

    expect(result).toBe("http://localhost:9000");
  });

  it("should return NEXT_PUBLIC_ARCHESTRA_API_BASE_URL when set", () => {
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL = "https://api.example.com";

    const result = getBackendBaseUrl();

    expect(result).toBe("https://api.example.com");
  });

  it("should prioritize NEXT_PUBLIC over ARCHESTRA_API_BASE_URL", () => {
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL =
      "https://public.example.com";
    process.env.ARCHESTRA_API_BASE_URL = "https://private.example.com";

    const result = getBackendBaseUrl();

    expect(result).toBe("https://public.example.com");
  });

  // Note: ARCHESTRA_API_BASE_URL fallback (server-side only) is tested in
  // src/app/api/auth/[...path]/route.test.ts which runs in Node environment.
  // That test verifies the API route correctly uses getBackendBaseUrl().

  it("should return default when NEXT_PUBLIC is empty string", () => {
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL = "";
    delete process.env.ARCHESTRA_API_BASE_URL;

    const result = getBackendBaseUrl();

    expect(result).toBe("http://localhost:9000");
  });

  it("should handle URLs with ports", () => {
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL = "http://localhost:8080";

    const result = getBackendBaseUrl();

    expect(result).toBe("http://localhost:8080");
  });

  it("should handle URLs with paths", () => {
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL =
      "https://api.example.com/archestra";

    const result = getBackendBaseUrl();

    expect(result).toBe("https://api.example.com/archestra");
  });
});

describe("getExternalBaseUrl", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return external URL when NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL is set", () => {
    process.env.NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL =
      "https://api.archestra.com";
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL = "http://localhost:9000";

    const result = _getExternalBaseUrl();

    expect(result).toBe("https://api.archestra.com");
  });

  it("should fall back to getBackendBaseUrl when external URL is not set", () => {
    delete process.env.NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL;
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL =
      "https://internal.example.com";

    const result = _getExternalBaseUrl();

    expect(result).toBe("https://internal.example.com");
  });

  it("should fall back to default when no env vars are set", () => {
    delete process.env.NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL;
    delete process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL;
    delete process.env.ARCHESTRA_API_BASE_URL;

    const result = _getExternalBaseUrl();

    expect(result).toBe("http://localhost:9000");
  });

  it("should fall back to getBackendBaseUrl when external URL is empty string", () => {
    process.env.NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL = "";
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL =
      "https://internal.example.com";

    const result = _getExternalBaseUrl();

    expect(result).toBe("https://internal.example.com");
  });
});

describe("getExternalProxyUrl", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return default localhost URL with /v1 when env var is not set", () => {
    delete process.env.NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL;
    delete process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL;
    delete process.env.ARCHESTRA_API_BASE_URL;

    const result = getExternalProxyUrl();

    expect(result).toBe("http://localhost:9000/v1");
  });

  it("should use external URL when ARCHESTRA_API_EXTERNAL_BASE_URL is set", () => {
    process.env.NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL =
      "https://api.archestra.com";
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL = "http://localhost:9000";

    const result = getExternalProxyUrl();

    expect(result).toBe("https://api.archestra.com/v1");
  });

  it("should return URL as-is when it already ends with /v1", () => {
    delete process.env.NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL;
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL =
      "https://api.example.com/v1";

    const result = getExternalProxyUrl();

    expect(result).toBe("https://api.example.com/v1");
  });

  it("should remove trailing slash and append /v1 when URL ends with /", () => {
    delete process.env.NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL;
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL = "https://api.example.com/";

    const result = getExternalProxyUrl();

    expect(result).toBe("https://api.example.com/v1");
  });

  it("should append /v1 when URL has no trailing slash", () => {
    delete process.env.NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL;
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL = "https://api.example.com";

    const result = getExternalProxyUrl();

    expect(result).toBe("https://api.example.com/v1");
  });

  it("should handle URLs with paths correctly", () => {
    delete process.env.NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL;
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL =
      "https://api.example.com/proxy";

    const result = getExternalProxyUrl();

    expect(result).toBe("https://api.example.com/proxy/v1");
  });

  it("should handle URLs with paths ending in slash correctly", () => {
    delete process.env.NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL;
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL =
      "https://api.example.com/proxy/";

    const result = getExternalProxyUrl();

    expect(result).toBe("https://api.example.com/proxy/v1");
  });

  it("should handle localhost URLs with ports", () => {
    delete process.env.NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL;
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL = "http://localhost:8080";

    const result = getExternalProxyUrl();

    expect(result).toBe("http://localhost:8080/v1");
  });

  it("should handle empty string env var as if not set", () => {
    delete process.env.NEXT_PUBLIC_ARCHESTRA_API_EXTERNAL_BASE_URL;
    process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL = "";

    const result = getExternalProxyUrl();

    expect(result).toBe("http://localhost:9000/v1");
  });
});

describe("getWebSocketUrl", () => {
  const originalEnv = process.env;
  const originalWindow = global.window;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.window = originalWindow;
  });

  describe("client-side (window defined)", () => {
    it("should use window.location for WebSocket URL with http protocol", () => {
      // jsdom provides window with location
      Object.defineProperty(window, "location", {
        value: { protocol: "http:", host: "example.com:3000" },
        writable: true,
      });

      const result = getWebSocketUrl();

      expect(result).toBe("ws://example.com:3000/ws");
    });

    it("should use wss protocol when page is served over https", () => {
      Object.defineProperty(window, "location", {
        value: { protocol: "https:", host: "secure.example.com" },
        writable: true,
      });

      const result = getWebSocketUrl();

      expect(result).toBe("wss://secure.example.com/ws");
    });

    it("should use current host for localhost development", () => {
      Object.defineProperty(window, "location", {
        value: { protocol: "http:", host: "localhost:3000" },
        writable: true,
      });

      const result = getWebSocketUrl();

      expect(result).toBe("ws://localhost:3000/ws");
    });
  });

  describe("server-side (window undefined)", () => {
    beforeEach(() => {
      // @ts-expect-error - intentionally setting window to undefined for server-side test
      global.window = undefined;
    });

    it("should return default WebSocket URL when env var is not set", () => {
      delete process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL;
      delete process.env.ARCHESTRA_API_BASE_URL;

      const result = getWebSocketUrl();

      expect(result).toBe("ws://localhost:9000/ws");
    });

    it("should convert http to ws", () => {
      process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL = "http://api.example.com";

      const result = getWebSocketUrl();

      expect(result).toBe("ws://api.example.com/ws");
    });

    it("should convert https to wss", () => {
      process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL =
        "https://api.example.com";

      const result = getWebSocketUrl();

      expect(result).toBe("wss://api.example.com/ws");
    });

    it("should handle URLs with ports", () => {
      process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL = "http://localhost:8080";

      const result = getWebSocketUrl();

      expect(result).toBe("ws://localhost:8080/ws");
    });

    it("should handle URLs with paths", () => {
      process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL =
        "https://api.example.com/archestra";

      const result = getWebSocketUrl();

      expect(result).toBe("wss://api.example.com/archestra/ws");
    });

    it("should handle URLs with trailing slash", () => {
      process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL =
        "https://api.example.com/";

      const result = getWebSocketUrl();

      expect(result).toBe("wss://api.example.com//ws");
    });

    it("should handle empty string env var as if not set", () => {
      process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL = "";

      const result = getWebSocketUrl();

      expect(result).toBe("ws://localhost:9000/ws");
    });
  });
});
