import { describe, expect, test } from "vitest";
import { sanitizeSvg } from "./sanitize-svg";

describe("sanitizeSvg", () => {
  test("preserves a benign SVG document", () => {
    const input = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>`;
    const result = sanitizeSvg(input);
    expect(result).toContain("<svg");
    expect(result).toContain("<rect");
    expect(result).toContain('fill="red"');
  });

  test("strips inline <script> tags", () => {
    const input = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>`;
    const result = sanitizeSvg(input);
    expect(result).not.toContain("<script");
    expect(result).not.toContain("alert");
    expect(result).toContain("<rect");
  });

  test("strips event-handler attributes", () => {
    const input = `<svg xmlns="http://www.w3.org/2000/svg"><rect onload="alert(1)" onclick="evil()" width="10" height="10"/></svg>`;
    const result = sanitizeSvg(input);
    expect(result).not.toContain("onload");
    expect(result).not.toContain("onclick");
    expect(result).not.toContain("alert");
    expect(result).toContain("<rect");
  });

  test("strips foreignObject (HTML smuggling)", () => {
    const input = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>html</div></foreignObject></svg>`;
    const result = sanitizeSvg(input);
    expect(result).not.toContain("foreignObject");
    expect(result).not.toContain("<div");
  });

  test("strips javascript: URLs in href / xlink:href", () => {
    const input = `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect width="10" height="10"/></a></svg>`;
    const result = sanitizeSvg(input);
    expect(result).not.toContain("javascript:");
  });

  test("returns null for non-SVG input", () => {
    expect(sanitizeSvg("<html><body>nope</body></html>")).toBe(null);
    expect(sanitizeSvg("")).toBe(null);
    expect(sanitizeSvg("plain text")).toBe(null);
  });
});
