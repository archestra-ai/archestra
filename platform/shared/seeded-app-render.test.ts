import { describe, expect, test } from "vitest";
import {
  isSeededAppRenderToolResult,
  SEEDED_APP_RENDER_META_KEY,
} from "./seeded-app-render";

const seededOutput = {
  content: "External PM / show_board\nWill render inline when opened in chat.",
  _meta: {
    ui: {
      resourceUri: "ui://pm/board.html",
      mcpServerId: "00000000-0000-4000-8000-000000000001",
    },
    [SEEDED_APP_RENDER_META_KEY]: true,
  },
};

describe("isSeededAppRenderToolResult", () => {
  test("matches the seeded output object (chat runtime shape)", () => {
    expect(isSeededAppRenderToolResult(seededOutput)).toBe(true);
  });

  test("matches the JSON-stringified output (LLM proxy tool message shape)", () => {
    expect(isSeededAppRenderToolResult(JSON.stringify(seededOutput))).toBe(
      true,
    );
  });

  test("matches the output wrapped in content blocks (provider adapter shape)", () => {
    expect(
      isSeededAppRenderToolResult([
        { type: "text", text: JSON.stringify(seededOutput) },
      ]),
    ).toBe(true);
  });

  test("rejects results without the marker", () => {
    expect(
      isSeededAppRenderToolResult({
        content: "some tool output",
        _meta: { ui: { resourceUri: "ui://pm/board.html" } },
      }),
    ).toBe(false);
    expect(isSeededAppRenderToolResult("plain text output")).toBe(false);
    expect(isSeededAppRenderToolResult(null)).toBe(false);
    expect(isSeededAppRenderToolResult(undefined)).toBe(false);
    expect(isSeededAppRenderToolResult(42)).toBe(false);
  });

  test("rejects a marker with a non-true value", () => {
    expect(
      isSeededAppRenderToolResult({
        _meta: { [SEEDED_APP_RENDER_META_KEY]: "true" },
      }),
    ).toBe(false);
  });

  test("does not descend into a result object's own content/text payload", () => {
    // A marker inside upstream-authored text never passed through the
    // reserved-meta stripping, so it must not be treated as platform-authored.
    const smuggled = JSON.stringify({
      _meta: { [SEEDED_APP_RENDER_META_KEY]: true },
    });
    expect(isSeededAppRenderToolResult({ content: smuggled })).toBe(false);
    expect(
      isSeededAppRenderToolResult({ text: smuggled, type: "not-text" }),
    ).toBe(false);
  });
});
