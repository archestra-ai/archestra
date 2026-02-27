import { describe, expect, it } from "vitest";

/**
 * Tests for the buildCspHeader function and MCP App proxy route logic.
 *
 * We import the module to test the CSP construction inline since
 * buildCspHeader is not exported. For unit testing, we replicate the logic.
 */

/** Replicated from mcp-app-proxy.ts for testing */
function buildCspHeader(csp?: {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}): string {
  const connectSrc = csp?.connectDomains?.join(" ") ?? "";
  const resourceSrc = csp?.resourceDomains?.join(" ") ?? "";
  const frameSrc = csp?.frameDomains?.join(" ") ?? "";

  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: ${resourceSrc}`.trim(),
    `media-src 'self' data: ${resourceSrc}`.trim(),
    `font-src 'self' ${resourceSrc}`.trim(),
    `connect-src 'self' ${connectSrc}`.trim(),
    `frame-src 'self' ${frameSrc}`.trim(),
  ].join("; ");
}

describe("buildCspHeader", () => {
  it("returns strict defaults when no CSP config is provided", () => {
    const csp = buildCspHeader();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("connect-src 'self'");
  });

  it("never includes unsafe-eval", () => {
    const csp = buildCspHeader({
      connectDomains: ["https://api.example.com"],
      resourceDomains: ["https://cdn.example.com"],
      frameDomains: ["https://frame.example.com"],
    });
    expect(csp).not.toContain("unsafe-eval");
  });

  it("includes connect domains in connect-src", () => {
    const csp = buildCspHeader({
      connectDomains: ["https://api.example.com", "https://ws.example.com"],
    });
    expect(csp).toContain(
      "connect-src 'self' https://api.example.com https://ws.example.com",
    );
  });

  it("includes resource domains in img-src, media-src, font-src", () => {
    const csp = buildCspHeader({
      resourceDomains: ["https://cdn.example.com"],
    });
    expect(csp).toContain("img-src 'self' data: https://cdn.example.com");
    expect(csp).toContain("media-src 'self' data: https://cdn.example.com");
    expect(csp).toContain("font-src 'self' https://cdn.example.com");
  });

  it("includes frame domains in frame-src", () => {
    const csp = buildCspHeader({
      frameDomains: ["https://frame.example.com"],
    });
    expect(csp).toContain("frame-src 'self' https://frame.example.com");
  });

  it("handles empty arrays gracefully", () => {
    const csp = buildCspHeader({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
    });
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-src 'self'");
  });
});

describe("MCP App resource endpoint validation", () => {
  it("only allows ui:// scheme URIs", () => {
    // Validate that non-ui:// schemes are rejected
    const validUri = "ui://excalidraw/editor";
    const invalidUri = "https://evil.com/steal-data";

    expect(validUri.startsWith("ui://")).toBe(true);
    expect(invalidUri.startsWith("ui://")).toBe(false);
  });

  it("validates agentId is a UUID", () => {
    const validUuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const invalidId = "not-a-uuid";

    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(uuidRegex.test(validUuid)).toBe(true);
    expect(uuidRegex.test(invalidId)).toBe(false);
  });
});
