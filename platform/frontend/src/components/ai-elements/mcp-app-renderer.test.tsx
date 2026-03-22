import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  McpAppRenderer,
  extractUIResource,
  hasUIResource,
} from "./mcp-app-renderer";

describe("extractUIResource", () => {
  it("returns null for non-object output", () => {
    expect(extractUIResource(null)).toBeNull();
    expect(extractUIResource(undefined)).toBeNull();
    expect(extractUIResource(42)).toBeNull();
    expect(extractUIResource("plain text")).toBeNull();
  });

  it("extracts from top-level uri + mimeType", () => {
    const output = {
      uri: "ui://weather",
      mimeType: "text/html",
      text: "<h1>Weather</h1>",
    };
    const result = extractUIResource(output);
    expect(result).toEqual(output);
  });

  it("extracts from _meta.ui pattern", () => {
    const resource = {
      uri: "ui://chart",
      mimeType: "text/html",
      text: "<canvas></canvas>",
    };
    const output = {
      data: [1, 2, 3],
      _meta: { ui: resource },
    };
    const result = extractUIResource(output);
    expect(result).toEqual(resource);
  });

  it("extracts from JSON string output", () => {
    const resource = {
      uri: "https://app.example.com",
      mimeType: "text/uri-list",
    };
    const result = extractUIResource(JSON.stringify(resource));
    expect(result).toEqual(resource);
  });

  it("returns null for invalid mimeType", () => {
    const output = {
      uri: "ui://widget",
      mimeType: "application/json",
    };
    expect(extractUIResource(output)).toBeNull();
  });

  it("returns null for missing uri", () => {
    const output = { mimeType: "text/html", text: "<div>test</div>" };
    expect(extractUIResource(output)).toBeNull();
  });
});

describe("hasUIResource", () => {
  it("returns true for valid UIResource output", () => {
    expect(
      hasUIResource({ uri: "ui://x", mimeType: "text/html" }),
    ).toBe(true);
  });

  it("returns false for plain object output", () => {
    expect(hasUIResource({ result: "ok" })).toBe(false);
  });
});

describe("McpAppRenderer", () => {
  it("renders an iframe for text/html content", () => {
    render(
      <McpAppRenderer
        resource={{
          uri: "ui://test",
          mimeType: "text/html",
          text: "<h1>Hello</h1>",
        }}
      />,
    );
    const iframe = screen.getByTitle("MCP App");
    expect(iframe).toBeDefined();
    expect(iframe.getAttribute("sandbox")).toBe(
      "allow-scripts allow-forms allow-popups",
    );
  });

  it("renders an iframe with src for text/uri-list", () => {
    render(
      <McpAppRenderer
        resource={{
          uri: "https://example.com/app",
          mimeType: "text/uri-list",
        }}
      />,
    );
    const iframe = screen.getByTitle("MCP App");
    expect(iframe.getAttribute("src")).toBe("https://example.com/app");
  });

  it("shows unsupported message for remote-dom+json", () => {
    render(
      <McpAppRenderer
        resource={{
          uri: "ui://remote",
          mimeType: "application/remote-dom+json",
        }}
      />,
    );
    expect(
      screen.getByText("Remote DOM rendering is not yet supported."),
    ).toBeDefined();
  });

  it("renders external link button for uri-list type", () => {
    render(
      <McpAppRenderer
        resource={{
          uri: "https://example.com/app",
          mimeType: "text/uri-list",
        }}
      />,
    );
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://example.com/app");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("renders expand/collapse button", async () => {
    const user = userEvent.setup();
    render(
      <McpAppRenderer
        resource={{
          uri: "ui://test",
          mimeType: "text/html",
          text: "<p>Content</p>",
        }}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
  });
});
