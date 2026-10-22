// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatJsonPreview } from "./format-json-preview";

describe("formatJsonPreview", () => {
  it("indents nested objects and arrays, keeping empty containers compact", () => {
    expect(formatJsonPreview('{"items":[{"count":2},[],{}],"ok":true}')).toBe(
      '{\n  "items": [\n    {\n      "count": 2\n    },\n    [],\n    {}\n  ],\n  "ok": true\n}',
    );
  });

  it("preserves numeric precision, duplicate keys and string escapes", () => {
    const source = String.raw`{"id":9007199254740993,"id":1.2300e+40,"text":"commas, braces{} and \"quotes\" \\ \u0061"}`;
    const formatted = formatJsonPreview(source);
    expect(formatted).toContain("9007199254740993");
    expect(formatted).toContain("1.2300e+40");
    expect(formatted?.match(/"id"/g)).toHaveLength(2);
    expect(formatted).toContain(
      String.raw`"commas, braces{} and \"quotes\" \\ \u0061"`,
    );
  });

  it.each([
    "null",
    "true",
    "42",
    '"hello"',
    "[]",
    "{}",
  ])("handles root value %s", (source) => {
    expect(formatJsonPreview(source)).toBe(source);
  });

  it.each([
    "",
    '{"truncated":',
    '{"a":1,}',
    "not JSON",
  ])("rejects invalid JSON %s for source fallback", (source) => {
    expect(formatJsonPreview(source)).toBeNull();
  });
});
