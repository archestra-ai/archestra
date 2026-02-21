import { describe, expect, it } from "vitest";
import {
  extractInlineMcpAppHtml,
  extractMcpAppResourceUri,
  hasMcpAppMeta,
} from "./mcp-apps";

describe("extractMcpAppResourceUri", () => {
  it("extracts URI from valid meta with ui:// scheme", () => {
    const meta = { ui: { resourceUri: "ui://my-app" } };
    expect(extractMcpAppResourceUri(meta)).toBe("ui://my-app");
  });

  it("returns null when ui field is missing", () => {
    expect(extractMcpAppResourceUri({})).toBeNull();
  });

  it("returns null for null input", () => {
    expect(extractMcpAppResourceUri(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(extractMcpAppResourceUri(undefined)).toBeNull();
  });

  it("returns null for non-ui:// scheme URIs", () => {
    const meta = { ui: { resourceUri: "https://example.com" } };
    expect(extractMcpAppResourceUri(meta)).toBeNull();
  });

  it("returns null for primitive inputs", () => {
    expect(extractMcpAppResourceUri(42)).toBeNull();
    expect(extractMcpAppResourceUri("string")).toBeNull();
    expect(extractMcpAppResourceUri(true)).toBeNull();
  });

  it("extracts URI when permissions and csp are present", () => {
    const meta = {
      ui: {
        resourceUri: "ui://dashboard",
        permissions: ["microphone", "camera"],
        csp: { "script-src": "https://cdn.example.com" },
      },
    };
    expect(extractMcpAppResourceUri(meta)).toBe("ui://dashboard");
  });

  it("returns null when resourceUri is empty string", () => {
    const meta = { ui: { resourceUri: "" } };
    expect(extractMcpAppResourceUri(meta)).toBeNull();
  });
});

describe("extractInlineMcpAppHtml", () => {
  it("extracts HTML from content array with ui:// resource type", () => {
    const output = {
      content: [
        { type: "resource", uri: "ui://app", text: "<div>Hello</div>" },
      ],
    };
    expect(extractInlineMcpAppHtml(output)).toBe("<div>Hello</div>");
  });

  it("extracts HTML from text/html mime type items", () => {
    const output = {
      content: [
        {
          type: "text",
          mimeType: "text/html",
          text: "<h1>Dashboard</h1>",
        },
      ],
    };
    expect(extractInlineMcpAppHtml(output)).toBe("<h1>Dashboard</h1>");
  });

  it("handles stringified JSON output", () => {
    const output = JSON.stringify({
      content: [
        { type: "resource", uri: "ui://app", text: "<p>Test</p>" },
      ],
    });
    expect(extractInlineMcpAppHtml(output)).toBe("<p>Test</p>");
  });

  it("returns null for plain string output", () => {
    expect(extractInlineMcpAppHtml("plain text result")).toBeNull();
  });

  it("returns null for object without content array", () => {
    expect(extractInlineMcpAppHtml({ result: "data" })).toBeNull();
  });

  it("returns null for null", () => {
    expect(extractInlineMcpAppHtml(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(extractInlineMcpAppHtml(undefined)).toBeNull();
  });

  it("ignores non-ui:// resource items", () => {
    const output = {
      content: [
        {
          type: "resource",
          uri: "https://example.com",
          text: "<div>Not MCP App</div>",
        },
      ],
    };
    expect(extractInlineMcpAppHtml(output)).toBeNull();
  });

  it("ignores text items without text/html mimeType", () => {
    const output = {
      content: [
        {
          type: "text",
          mimeType: "text/plain",
          text: "Not HTML",
        },
      ],
    };
    expect(extractInlineMcpAppHtml(output)).toBeNull();
  });

  it("returns first match when multiple MCP App items exist", () => {
    const output = {
      content: [
        { type: "text", text: "Regular text" },
        { type: "resource", uri: "ui://first", text: "<div>First</div>" },
        { type: "resource", uri: "ui://second", text: "<div>Second</div>" },
      ],
    };
    expect(extractInlineMcpAppHtml(output)).toBe("<div>First</div>");
  });
});

describe("hasMcpAppMeta", () => {
  it("returns true for valid MCP App meta with ui:// URI", () => {
    expect(hasMcpAppMeta({ ui: { resourceUri: "ui://app" } })).toBe(true);
  });

  it("returns false for empty object", () => {
    expect(hasMcpAppMeta({})).toBe(false);
  });

  it("returns false for null", () => {
    expect(hasMcpAppMeta(null)).toBe(false);
  });

  it("returns false for meta without ui:// scheme", () => {
    expect(
      hasMcpAppMeta({ ui: { resourceUri: "https://not-mcp.com" } }),
    ).toBe(false);
  });
});
