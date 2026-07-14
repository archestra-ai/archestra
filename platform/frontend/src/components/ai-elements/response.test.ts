import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { isSameOriginUrl, Response } from "./response";

const APP_ID = "7b0839a1-4663-4371-a739-e5dac7f8c33e";

// linkSafety off makes Streamdown render a real <a href> we can read, instead of
// the safe-link <button> whose target lives in an onClick closure.
function renderResponse(markdown: string) {
  return render(
    createElement(Response, { linkSafety: { enabled: false } }, markdown),
  );
}

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

// Renders through the real Streamdown pipeline (including rehype-harden), so it
// verifies the repair runs before harden — harden would otherwise drop a
// slash-less relative link and it would never reach an <a href>.
describe("Response app-link canonicalization", () => {
  it("renders a slash-dropped app link as the absolute app path", () => {
    const { container } = renderResponse(`[Open](a/${APP_ID})`);
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe(`/a/${APP_ID}`);
    expect(anchor?.textContent).toBe("Open");
  });

  it("leaves an already-absolute app link unchanged", () => {
    const { container } = renderResponse(`[Open](/a/${APP_ID})`);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      `/a/${APP_ID}`,
    );
  });

  it("does not rewrite an external link", () => {
    const { container } = renderResponse(
      `[Site](https://example.com/a/${APP_ID})`,
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      `https://example.com/a/${APP_ID}`,
    );
  });

  it("only repairs the exact app-id shape, not any slashless a/ prefix", () => {
    // Slashless but not a UUID: the repair keys on the app-id shape, so it must
    // NOT promote this to an absolute `/a/…` link. (harden then blocks the
    // slashless relative link, so no anchor survives — the point is only that
    // our plugin did not rewrite it.)
    const { container } = renderResponse("[Docs](a/not-a-uuid)");
    expect(container.querySelector('a[href="/a/not-a-uuid"]')).toBeNull();
  });

  it("does not rewrite the pattern inside a code span", () => {
    const { container } = renderResponse(`\`a/${APP_ID}\``);
    expect(container.querySelector("code")?.textContent).toBe(`a/${APP_ID}`);
  });
});
