import { describe, expect, it } from "vitest";
import { isSameOriginUrl } from "./response";

describe("isSameOriginUrl", () => {
  // jsdom sets window.location.origin to "http://localhost:3000" by default in vitest

  it("returns true for same-origin absolute URL", () => {
    expect(isSameOriginUrl("http://localhost:3000/mcp/registry")).toBe(true);
  });

  it("returns true for same-origin URL with query params", () => {
    expect(
      isSameOriginUrl("http://localhost:3000/mcp/registry?install=cat_abc123"),
    ).toBe(true);
  });

  it("returns true for same-origin URL with hash", () => {
    expect(isSameOriginUrl("http://localhost:3000/settings#tab")).toBe(true);
  });

  it("returns true for relative path (resolved against current origin)", () => {
    expect(isSameOriginUrl("/mcp/registry?install=cat_abc")).toBe(true);
  });

  it("returns false for different host", () => {
    expect(isSameOriginUrl("https://evil.com/phishing")).toBe(false);
  });

  it("returns false for different port", () => {
    expect(isSameOriginUrl("http://localhost:9000/api/config")).toBe(false);
  });

  it("returns false for different protocol (http vs https)", () => {
    expect(isSameOriginUrl("https://localhost:3000/mcp/registry")).toBe(false);
  });

  it("returns true for relative-looking strings (resolved against current origin)", () => {
    // "not a url at all" gets resolved as a relative path by the URL constructor
    expect(isSameOriginUrl("not a url at all")).toBe(true);
  });

  it("returns false for javascript: protocol", () => {
    expect(isSameOriginUrl("javascript:alert(1)")).toBe(false);
  });

  it("returns false for data: URI", () => {
    expect(isSameOriginUrl("data:text/html,<h1>hi</h1>")).toBe(false);
  });
});
