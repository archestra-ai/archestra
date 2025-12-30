import { describe, it, expect } from "vitest";
import {
  extractUIResourceFromOutput,
  isUIResource,
} from "./index";
import type { UIResource } from "./index";

describe("isUIResource", () => {
  it("should return true for a valid UIResource", () => {
    const resource: UIResource = {
      type: "resource",
      resource: {
        uri: "ui://test",
        mimeType: "text/html",
      },
    };
    expect(isUIResource(resource)).toBe(true);
  });

  it("should return false for an invalid object", () => {
    expect(isUIResource({})).toBe(false);
    expect(isUIResource({ type: "resource" })).toBe(false);
    expect(isUIResource({ resource: {} })).toBe(false);
    expect(isUIResource(null)).toBe(false);
    expect(isUIResource(undefined)).toBe(false);
    expect(isUIResource("string")).toBe(false);
  });
});

describe("extractUIResourceFromOutput", () => {
  const uiResource: UIResource = {
    type: "resource",
    resource: {
      uri: "ui://test",
      mimeType: "text/html",
      text: "<h1>Hello</h1>",
    },
  };

  it("should extract a UIResource from a direct object", () => {
    const output = uiResource;
    expect(extractUIResourceFromOutput(output)).toEqual(uiResource);
  });

  it("should extract a UIResource from a JSON string", () => {
    const output = JSON.stringify(uiResource);
    expect(extractUIResourceFromOutput(output)).toEqual(uiResource);
  });

  it("should extract a UIResource from an array of objects", () => {
    const output = [
      { type: "text", text: "some text" },
      uiResource,
      { type: "text", text: "more text" },
    ];
    expect(extractUIResourceFromOutput(output)).toEqual(uiResource);
  });

  it("should extract a UIResource from a nested content array", () => {
    const output = {
      content: [
        { type: "text", text: "some text" },
        uiResource,
        { type: "text", text: "more text" },
      ],
    };
    expect(extractUIResourceFromOutput(output)).toEqual(uiResource);
  });
    it("should extract a UIResource from a parsed JSON with content array", () => {
    const output = JSON.stringify({
      content: [
        { type: "text", text: "some text" },
        uiResource,
        { type: "text", text: "more text" },
      ],
    });
    expect(extractUIResourceFromOutput(output)).toEqual(uiResource);
  });


  it("should return null for invalid or empty inputs", () => {
    expect(extractUIResourceFromOutput(null)).toBeNull();
    expect(extractUIResourceFromOutput(undefined)).toBeNull();
    expect(extractUIResourceFromOutput("")).toBeNull();
    expect(extractUIResourceFromOutput("{}")).toBeNull();
    expect(extractUIResourceFromOutput("[]")).toBeNull();
    expect(extractUIResourceFromOutput({ content: [] })).toBeNull();
  });
});
