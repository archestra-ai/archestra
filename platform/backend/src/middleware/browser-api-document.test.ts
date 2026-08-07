import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  getBrowserApiFaviconHref,
  isJsonContentType,
  renderBrowserApiDocument,
  shouldRenderBrowserApiDocument,
} from "./browser-api-document";

const PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==";

function request(overrides: Partial<FastifyRequest> = {}) {
  return {
    method: "GET",
    url: "/api/teams",
    headers: {
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
    },
    ...overrides,
  } as FastifyRequest;
}

describe("browser API document", () => {
  it("matches Fetch Metadata navigations for every API URL shape", () => {
    expect(shouldRenderBrowserApiDocument(request())).toBe(true);
    expect(
      shouldRenderBrowserApiDocument(request({ url: "/api?source=qa" })),
    ).toBe(true);
    expect(
      shouldRenderBrowserApiDocument(
        request({ url: "/api/future/nested/route?source=qa" }),
      ),
    ).toBe(true);
    expect(
      shouldRenderBrowserApiDocument(
        request({ url: "https://example.test/api/teams?source=qa" }),
      ),
    ).toBe(true);
    expect(shouldRenderBrowserApiDocument(request({ method: "POST" }))).toBe(
      false,
    );
    expect(shouldRenderBrowserApiDocument(request({ url: "/v1/models" }))).toBe(
      false,
    );
  });

  it("falls back to explicit HTML negotiation when metadata is absent", () => {
    expect(
      shouldRenderBrowserApiDocument(
        request({ headers: { accept: "text/html,application/xhtml+xml" } }),
      ),
    ).toBe(true);
    expect(
      shouldRenderBrowserApiDocument(
        request({ headers: { accept: "TEXT/HTML;Q=0.8" } }),
      ),
    ).toBe(true);
    expect(
      shouldRenderBrowserApiDocument(
        request({ headers: { accept: "text/html;q=0,application/json" } }),
      ),
    ).toBe(false);
    expect(
      shouldRenderBrowserApiDocument(
        request({ headers: { accept: "application/json, */*" } }),
      ),
    ).toBe(false);
    expect(shouldRenderBrowserApiDocument(request({ headers: {} }))).toBe(
      false,
    );
  });

  it("keeps explicit non-document requests as JSON", () => {
    expect(
      shouldRenderBrowserApiDocument(
        request({
          headers: {
            accept: "text/html",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
          },
        }),
      ),
    ).toBe(false);
  });

  it("recognizes JSON response content types", () => {
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("application/problem+json")).toBe(true);
    expect(isJsonContentType("text/event-stream")).toBe(false);
  });

  it("uses a content-versioned custom favicon URL", () => {
    expect(getBrowserApiFaviconHref(PNG_DATA_URI)).toBe(
      "/favicon.ico?v=48ac386978254451",
    );
    expect(getBrowserApiFaviconHref(null)).toBe("/default-favicon.ico");
  });

  it("renders escaped JSON with an explicit favicon link", () => {
    const html = renderBrowserApiDocument(
      '{"value":"<script>&</script>"}',
      "/favicon.ico?v=abc123",
    );

    expect(html).toContain('<link rel="icon" href="/favicon.ico?v=abc123">');
    expect(html).toContain(
      '<pre>{"value":"&lt;script&gt;&amp;&lt;/script&gt;"}</pre>',
    );
    expect(html).not.toContain("<script>");
  });
});
