import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config/config", () => ({
  getBackendBaseUrl: () => "http://localhost:9000",
}));

import { GET } from "./route";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==";
const PNG_VERSION = "48ac386978254451";

function request(version?: string) {
  const url = new URL("http://localhost:3000/favicon.ico");
  if (version) url.searchParams.set("v", version);
  return new Request(url);
}

describe("favicon route", () => {
  const fetchMock = vi.fn();
  const originalInternalApiBaseUrl =
    process.env.ARCHESTRA_INTERNAL_API_BASE_URL;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.ARCHESTRA_INTERNAL_API_BASE_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalInternalApiBaseUrl === undefined) {
      delete process.env.ARCHESTRA_INTERNAL_API_BASE_URL;
    } else {
      process.env.ARCHESTRA_INTERNAL_API_BASE_URL = originalInternalApiBaseUrl;
    }
  });

  it("prefers the server-only backend URL inside the frontend runtime", async () => {
    process.env.ARCHESTRA_INTERNAL_API_BASE_URL = "http://backend:9000";
    fetchMock.mockResolvedValue(Response.json({ favicon: null }));

    await GET(request());

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/organization/appearance-settings", "http://backend:9000"),
      { cache: "no-store" },
    );
  });

  it("redirects a custom favicon to a content-versioned URL", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ favicon: `data:image/png;base64,${PNG_BASE64}` }),
    );

    const response = await GET(request());

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/organization/appearance-settings", "http://localhost:9000"),
      { cache: "no-store" },
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `/favicon.ico?v=${PNG_VERSION}`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("serves the white-label favicon from its content-versioned URL", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ favicon: `data:image/png;base64,${PNG_BASE64}` }),
    );

    const response = await GET(request(PNG_VERSION));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(
      PNG_BASE64,
    );
  });

  it("redirects to the default icon when no custom favicon is configured", async () => {
    fetchMock.mockResolvedValue(Response.json({ favicon: null }));

    const response = await GET(request());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/default-favicon.ico");
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("redirects to the default icon for malformed favicon data", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ favicon: "data:image/png;base64,not valid" }),
    );

    const response = await GET(request());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/default-favicon.ico");
  });

  it("redirects to the default icon when appearance settings are unavailable", async () => {
    fetchMock.mockRejectedValue(new Error("backend unavailable"));

    const response = await GET(request());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/default-favicon.ico");
  });
});
