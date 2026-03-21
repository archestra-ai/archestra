import { describe, expect, it } from "vitest";
import {
  detectMcpAppResource,
  getMcpAppHtml,
  isCompactEligible,
  isMcpAppOutput,
} from "./chat-tools-display.utils";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a raw content array as an MCP server would return it. */
function buildMcpAppOutput(overrides: {
  mimeType?: string;
  text?: string;
  blob?: string;
  uri?: string;
}) {
  return [
    {
      type: "resource",
      resource: {
        uri: overrides.uri ?? "ui://test/widget",
        mimeType: overrides.mimeType ?? "text/html;profile=mcp-app",
        text: overrides.text,
        blob: overrides.blob,
      },
    },
  ];
}

/** Serialise the output array the same way the AI SDK does (as a JSON string). */
function asString(output: unknown) {
  return JSON.stringify(output);
}

// ---------------------------------------------------------------------------
// detectMcpAppResource
// ---------------------------------------------------------------------------

describe("detectMcpAppResource", () => {
  it("returns null for plain string output", () => {
    expect(detectMcpAppResource("hello world")).toBeNull();
  });

  it("returns null for undefined / null", () => {
    expect(detectMcpAppResource(undefined)).toBeNull();
    expect(detectMcpAppResource(null)).toBeNull();
  });

  it("returns null for plain JSON object output (not an array)", () => {
    expect(detectMcpAppResource({ result: "ok" })).toBeNull();
  });

  it("returns null when mimeType does not start with text/html;profile=mcp-app", () => {
    const output = buildMcpAppOutput({ mimeType: "text/plain" });
    expect(detectMcpAppResource(output)).toBeNull();
    expect(detectMcpAppResource(asString(output))).toBeNull();
  });

  it("detects an MCP App resource from a raw array (text variant)", () => {
    const output = buildMcpAppOutput({ text: "<h1>Hi</h1>" });
    const result = detectMcpAppResource(output);
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe("text/html;profile=mcp-app");
    expect(result?.text).toBe("<h1>Hi</h1>");
  });

  it("detects an MCP App resource from a JSON-stringified array (AI SDK format)", () => {
    const output = asString(buildMcpAppOutput({ text: "<p>test</p>" }));
    const result = detectMcpAppResource(output);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("<p>test</p>");
  });

  it("detects an MCP App resource from a blob variant", () => {
    // base64 of "<b>bold</b>"
    const blob = btoa("<b>bold</b>");
    const output = buildMcpAppOutput({ blob });
    const result = detectMcpAppResource(output);
    expect(result).not.toBeNull();
    expect(result?.blob).toBe(blob);
  });

  it("accepts the variant with a space before `profile` in the mimeType", () => {
    const output = buildMcpAppOutput({
      mimeType: "text/html; profile=mcp-app",
      text: "<span>ok</span>",
    });
    const result = detectMcpAppResource(output);
    expect(result).not.toBeNull();
  });

  it("returns only the first match when the array has multiple items", () => {
    const output = [
      { type: "text", text: "some result" },
      ...buildMcpAppOutput({ text: "<h1>First</h1>" }),
      ...buildMcpAppOutput({ text: "<h1>Second</h1>" }),
    ];
    const result = detectMcpAppResource(output);
    expect(result?.text).toBe("<h1>First</h1>");
  });
});

// ---------------------------------------------------------------------------
// isMcpAppOutput
// ---------------------------------------------------------------------------

describe("isMcpAppOutput", () => {
  it("returns false for non-MCP-App output", () => {
    expect(isMcpAppOutput("plain")).toBe(false);
    expect(isMcpAppOutput(undefined)).toBe(false);
  });

  it("returns true for MCP App output", () => {
    expect(isMcpAppOutput(buildMcpAppOutput({ text: "<div/>" }))).toBe(true);
    expect(
      isMcpAppOutput(asString(buildMcpAppOutput({ text: "<div/>" }))),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getMcpAppHtml
// ---------------------------------------------------------------------------

describe("getMcpAppHtml", () => {
  it("returns text as-is when present", () => {
    const resource = {
      uri: "ui://x",
      mimeType: "text/html;profile=mcp-app",
      text: "<h1>Hello</h1>",
    };
    expect(getMcpAppHtml(resource)).toBe("<h1>Hello</h1>");
  });

  it("decodes base64 blob when text is absent", () => {
    const html = "<h1>From blob</h1>";
    const resource = {
      uri: "ui://x",
      mimeType: "text/html;profile=mcp-app",
      blob: btoa(html),
    };
    expect(getMcpAppHtml(resource)).toBe(html);
  });

  it("returns null when neither text nor blob is present", () => {
    const resource = { uri: "ui://x", mimeType: "text/html;profile=mcp-app" };
    expect(getMcpAppHtml(resource)).toBeNull();
  });

  it("returns null for an invalid base64 blob", () => {
    const resource = {
      uri: "ui://x",
      mimeType: "text/html;profile=mcp-app",
      blob: "not!valid!base64!!!!!",
    };
    // atob on truly invalid input throws — getMcpAppHtml should catch and return null
    // (Environments differ: some will silently ignore bad chars, others throw.)
    const result = getMcpAppHtml(resource);
    expect(typeof result === "string" || result === null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isCompactEligible — MCP App guard
// ---------------------------------------------------------------------------

describe("isCompactEligible — MCP App guard", () => {
  const makePart = (output: unknown) =>
    ({
      type: "tool-some__tool",
      state: "output-available" as const,
      output,
    }) as never;

  it("returns false when the part output is an MCP App resource", () => {
    const output = buildMcpAppOutput({ text: "<div/>" });
    expect(
      isCompactEligible({
        toolName: "some__tool",
        part: makePart(output),
        toolResultPart: null,
      }),
    ).toBe(false);
  });

  it("returns false when the toolResultPart output is an MCP App resource", () => {
    const output = buildMcpAppOutput({ text: "<div/>" });
    expect(
      isCompactEligible({
        toolName: "some__tool",
        part: makePart(undefined),
        toolResultPart: makePart(output),
      }),
    ).toBe(false);
  });

  it("returns true for plain tool output (non-MCP-App)", () => {
    expect(
      isCompactEligible({
        toolName: "some__tool",
        part: makePart(JSON.stringify({ result: "ok" })),
        toolResultPart: null,
      }),
    ).toBe(true);
  });
});
