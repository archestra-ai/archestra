import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  type MCPContentItem,
  McpUiRenderer,
  parseMcpContent,
} from "./mcp-ui-renderer";

describe("parseMcpContent", () => {
  it("returns null for non-string input", () => {
    expect(parseMcpContent(42)).toBeNull();
    expect(parseMcpContent(null)).toBeNull();
    expect(parseMcpContent(undefined)).toBeNull();
    expect(parseMcpContent({ type: "text" })).toBeNull();
  });

  it("returns null for non-JSON strings", () => {
    expect(parseMcpContent("just a plain string")).toBeNull();
    expect(parseMcpContent("not json at all")).toBeNull();
  });

  it("returns null for non-array JSON", () => {
    expect(parseMcpContent('{"type":"text","text":"hello"}')).toBeNull();
    expect(parseMcpContent('"string"')).toBeNull();
  });

  it("returns null for arrays without type fields", () => {
    expect(parseMcpContent("[1, 2, 3]")).toBeNull();
    expect(parseMcpContent('[{"foo":"bar"}]')).toBeNull();
  });

  it("returns null for text-only arrays (no rich content)", () => {
    expect(parseMcpContent('[{"type":"text","text":"hello"}]')).toBeNull();
  });

  it("parses content with resource items", () => {
    const content = JSON.stringify([
      { type: "text", text: "Here is the widget:" },
      {
        type: "resource",
        resource: {
          uri: "ui://my-server/widget",
          mimeType: "text/html",
          text: "<h1>Widget</h1>",
        },
      },
    ]);
    const result = parseMcpContent(content);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result?.[0].type).toBe("text");
    expect(result?.[1].type).toBe("resource");
  });

  it("parses content with image items", () => {
    const content = JSON.stringify([
      { type: "text", text: "Generated chart:" },
      {
        type: "image",
        data: "base64data",
        mimeType: "image/png",
      },
    ]);
    const result = parseMcpContent(content);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result?.[1].type).toBe("image");
  });
});

describe("McpUiRenderer", () => {
  it("renders nothing for empty content", () => {
    const { container } = render(<McpUiRenderer content={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders text content", () => {
    const content: MCPContentItem[] = [
      { type: "text", text: "Hello from MCP tool" },
    ];
    render(<McpUiRenderer content={content} />);
    expect(screen.getByText("Hello from MCP tool")).toBeInTheDocument();
  });

  it("renders image content", () => {
    const content: MCPContentItem[] = [
      {
        type: "image",
        data: "dGVzdA==", // base64 of "test"
        mimeType: "image/png",
      },
    ];
    render(<McpUiRenderer content={content} />);
    const img = screen.getByAltText("MCP generated content");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "data:image/png;base64,dGVzdA==");
  });

  it("renders resource with URI", () => {
    const content: MCPContentItem[] = [
      {
        type: "resource",
        resource: {
          uri: "ui://my-server/widget",
          mimeType: "text/html",
          text: "<h1>Widget</h1>",
        },
      },
    ];
    render(<McpUiRenderer content={content} />);
    expect(screen.getByText("ui://my-server/widget")).toBeInTheDocument();
    expect(screen.getByText("MCP UI")).toBeInTheDocument();
    expect(screen.getByText("Expand UI")).toBeInTheDocument();
  });

  it("renders non-HTML resource as preview", () => {
    const content: MCPContentItem[] = [
      {
        type: "resource",
        resource: {
          uri: "data://my-server/output.json",
          mimeType: "application/json",
          text: '{"result": 42}',
        },
      },
    ];
    render(<McpUiRenderer content={content} />);
    expect(
      screen.getByText("data://my-server/output.json"),
    ).toBeInTheDocument();
    expect(screen.getByText("application/json")).toBeInTheDocument();
    expect(screen.getByText('{"result": 42}')).toBeInTheDocument();
  });

  it("expands HTML resource iframe on button click", async () => {
    const user = userEvent.setup();
    const content: MCPContentItem[] = [
      {
        type: "resource",
        resource: {
          uri: "ui://my-server/chart",
          mimeType: "text/html",
          text: "<h1>Chart</h1>",
        },
      },
    ];
    render(<McpUiRenderer content={content} />);

    // Initially no iframe visible
    expect(
      screen.queryByTitle("MCP UI Resource: ui://my-server/chart"),
    ).not.toBeInTheDocument();

    // Click expand
    await user.click(screen.getByText("Expand UI"));

    // Now iframe should be visible
    const iframe = screen.getByTitle("MCP UI Resource: ui://my-server/chart");
    expect(iframe).toBeInTheDocument();
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  });

  it("renders mixed content types", () => {
    const content: MCPContentItem[] = [
      { type: "text", text: "Analysis complete:" },
      {
        type: "image",
        data: "imagedata",
        mimeType: "image/jpeg",
      },
      {
        type: "resource",
        resource: {
          uri: "ui://analytics/dashboard",
          mimeType: "text/html;profile=mcp-app",
          text: "<div>Dashboard</div>",
        },
      },
    ];
    render(<McpUiRenderer content={content} />);
    expect(screen.getByText("Analysis complete:")).toBeInTheDocument();
    expect(screen.getByAltText("MCP generated content")).toBeInTheDocument();
    expect(screen.getByText("ui://analytics/dashboard")).toBeInTheDocument();
  });

  it("handles missing resource data gracefully", () => {
    const content: MCPContentItem[] = [
      {
        type: "resource",
        resource: undefined as unknown as MCPContentItem["resource"],
      } as MCPContentItem,
    ];
    render(<McpUiRenderer content={content} />);
    expect(screen.getByText("Missing resource data")).toBeInTheDocument();
  });

  it("handles unsupported content types gracefully", () => {
    const content = [
      { type: "unknown_type" as MCPContentItem["type"] },
    ] as MCPContentItem[];
    render(<McpUiRenderer content={content} />);
    expect(
      screen.getByText("Unsupported MCP content type: unknown_type"),
    ).toBeInTheDocument();
  });
});
