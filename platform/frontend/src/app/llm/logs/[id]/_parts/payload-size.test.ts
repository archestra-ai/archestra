import { describe, expect, it } from "vitest";
import { formatByteSize, jsonByteSize } from "./payload-size";

const encodedLength = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

describe("jsonByteSize", () => {
  it.each([
    ["a primitive", 42],
    ["null", null],
    ["an escaped string", 'quote " backslash \\ newline \n tab \t'],
    ["multi-byte text", "café — 日本語 🚀"],
    ["an empty object", {}],
    ["an empty array", []],
    [
      "a nested request",
      {
        model: "claude",
        messages: [
          { role: "user", content: [{ type: "text", text: "héllo" }] },
          { role: "assistant", content: [] },
        ],
        stream: true,
        temperature: 0.5,
      },
    ],
    ["undefined object fields", { kept: 1, dropped: undefined }],
    ["undefined array items", [1, undefined, 2]],
  ])("matches the UTF-8 length of compact JSON for %s", (_label, value) => {
    expect(jsonByteSize(value)).toBe(encodedLength(value));
  });
});

describe("formatByteSize", () => {
  it.each([
    [512, "512 B"],
    [2048, "2.0 KB"],
    [3.4 * 1024 * 1024, "3.4 MB"],
  ])("formats %d as %s", (bytes, expected) => {
    expect(formatByteSize(bytes)).toBe(expected);
  });
});
