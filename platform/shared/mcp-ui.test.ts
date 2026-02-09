import { describe, expect, it } from "vitest";
import { extractInlineMcpUiResource, extractMcpUiResourceUri } from "./mcp-ui";

describe("extractMcpUiResourceUri", () => {
  it("extracts resourceUri from _meta.ui.resourceUri", () => {
    const output = {
      _meta: { ui: { resourceUri: "ui://github/repos/me" } },
      content: [{ type: "text", text: "hello" }],
    };
    expect(extractMcpUiResourceUri(output)).toBe("ui://github/repos/me");
  });

  it("extracts from JSON string", () => {
    const output = JSON.stringify({
      _meta: { ui: { resourceUri: "ui://weather/current/London" } },
    });
    expect(extractMcpUiResourceUri(output)).toBe("ui://weather/current/London");
  });

  it("returns undefined for missing _meta", () => {
    expect(extractMcpUiResourceUri({ content: [] })).toBeUndefined();
  });

  it("returns undefined for null input", () => {
    expect(extractMcpUiResourceUri(null)).toBeUndefined();
  });

  it("returns undefined for non-JSON string", () => {
    expect(extractMcpUiResourceUri("not json")).toBeUndefined();
  });

  it("returns undefined for _meta without ui", () => {
    expect(
      extractMcpUiResourceUri({ _meta: { something: "else" } }),
    ).toBeUndefined();
  });
});

describe("extractInlineMcpUiResource", () => {
  it("extracts resource from content array", () => {
    const output = {
      content: [
        {
          type: "resource",
          resource: {
            uri: "ui://github/repos/me",
            mimeType: "text/html",
            text: "<h1>Hello</h1>",
          },
        },
      ],
    };
    const result = extractInlineMcpUiResource(output);
    expect(result).toEqual({
      uri: "ui://github/repos/me",
      mimeType: "text/html",
      text: "<h1>Hello</h1>",
      blob: undefined,
    });
  });

  it("extracts resource with blob", () => {
    const output = {
      content: [
        {
          type: "resource",
          resource: {
            uri: "ui://test",
            mimeType: "text/html",
            blob: btoa("<p>blob content</p>"),
          },
        },
      ],
    };
    const result = extractInlineMcpUiResource(output);
    expect(result?.uri).toBe("ui://test");
    expect(result?.blob).toBeDefined();
  });

  it("extracts from direct resource object", () => {
    const output = {
      type: "resource",
      resource: {
        uri: "ui://direct",
        mimeType: "text/html",
        text: "<div>direct</div>",
      },
    };
    const result = extractInlineMcpUiResource(output);
    expect(result?.uri).toBe("ui://direct");
  });

  it("returns undefined for non-resource content", () => {
    const output = {
      content: [{ type: "text", text: "just text" }],
    };
    expect(extractInlineMcpUiResource(output)).toBeUndefined();
  });

  it("returns undefined for resource without required fields", () => {
    const output = {
      content: [
        {
          type: "resource",
          resource: { uri: "ui://incomplete" },
        },
      ],
    };
    expect(extractInlineMcpUiResource(output)).toBeUndefined();
  });

  it("extracts from JSON string", () => {
    const output = JSON.stringify({
      content: [
        {
          type: "resource",
          resource: {
            uri: "ui://stringified",
            mimeType: "text/html",
            text: "<p>from string</p>",
          },
        },
      ],
    });
    const result = extractInlineMcpUiResource(output);
    expect(result?.uri).toBe("ui://stringified");
  });
});
