import { describe, expect, it } from "vitest";
import { extractUIResource, isUIResource } from "./ui-resource.utils";

describe("isUIResource", () => {
  it("should return false for null", () => {
    expect(isUIResource(null)).toBe(false);
  });

  it("should return false for undefined", () => {
    expect(isUIResource(undefined)).toBe(false);
  });

  it("should return false for strings", () => {
    expect(isUIResource("some string")).toBe(false);
  });

  it("should return false for objects without uri", () => {
    expect(isUIResource({ text: "hello" })).toBe(false);
  });

  it("should return false for non-ui:// URIs", () => {
    expect(isUIResource({ uri: "https://example.com", text: "content" })).toBe(
      false,
    );
  });

  it("should return false for ui:// URIs without content", () => {
    expect(isUIResource({ uri: "ui://component/test" })).toBe(false);
  });

  it("should return true for valid HTML UIResource", () => {
    expect(
      isUIResource({
        uri: "ui://component/test",
        mimeType: "text/html",
        text: "<div>Hello</div>",
      }),
    ).toBe(true);
  });

  it("should return true for valid URI list UIResource", () => {
    expect(
      isUIResource({
        uri: "ui://component/test",
        mimeType: "text/uri-list",
        text: "https://example.com/embed",
      }),
    ).toBe(true);
  });

  it("should return true for valid remote-dom UIResource", () => {
    expect(
      isUIResource({
        uri: "ui://component/test",
        mimeType: "application/vnd.mcp-ui.remote-dom",
        text: "export default () => {}",
      }),
    ).toBe(true);
  });

  it("should return true for UIResource with blob content", () => {
    expect(
      isUIResource({
        uri: "ui://component/test",
        mimeType: "text/html",
        blob: "base64encodedcontent",
      }),
    ).toBe(true);
  });

  it("should return true for UIResource without explicit mimeType", () => {
    expect(
      isUIResource({
        uri: "ui://component/test",
        text: "<div>Content</div>",
      }),
    ).toBe(true);
  });

  it("should return false for invalid mimeType", () => {
    expect(
      isUIResource({
        uri: "ui://component/test",
        mimeType: "application/json",
        text: "{}",
      }),
    ).toBe(false);
  });
});

describe("extractUIResource", () => {
  it("should return null for null input", () => {
    expect(extractUIResource(null)).toBeNull();
  });

  it("should return null for undefined input", () => {
    expect(extractUIResource(undefined)).toBeNull();
  });

  it("should extract direct UIResource object", () => {
    const resource = {
      uri: "ui://component/test",
      mimeType: "text/html",
      text: "<div>Hello</div>",
    };
    expect(extractUIResource(resource)).toEqual(resource);
  });

  it("should extract UIResource from JSON string", () => {
    const resource = {
      uri: "ui://component/test",
      mimeType: "text/html",
      text: "<div>Hello</div>",
    };
    expect(extractUIResource(JSON.stringify(resource))).toEqual(resource);
  });

  it("should extract UIResource from nested resource property", () => {
    const resource = {
      uri: "ui://component/test",
      mimeType: "text/html",
      text: "<div>Hello</div>",
    };
    expect(extractUIResource({ resource })).toEqual(resource);
  });

  it("should extract UIResource from MCP content array", () => {
    const resource = {
      uri: "ui://component/test",
      mimeType: "text/html",
      text: "<div>Hello</div>",
    };
    const mcpResult = {
      content: [{ type: "resource", resource }],
    };
    expect(extractUIResource(mcpResult)).toEqual(resource);
  });

  it("should extract UIResource from JSON string with nested resource", () => {
    const resource = {
      uri: "ui://component/test",
      mimeType: "text/html",
      text: "<div>Hello</div>",
    };
    expect(extractUIResource(JSON.stringify({ resource }))).toEqual(resource);
  });

  it("should return null for invalid JSON string", () => {
    expect(extractUIResource("not valid json")).toBeNull();
  });

  it("should return null for object without UIResource", () => {
    expect(extractUIResource({ foo: "bar" })).toBeNull();
  });
});
