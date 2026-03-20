import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const { mockUseTheme } = vi.hoisted(() => ({
  mockUseTheme: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => mockUseTheme(),
}));

import { ToolInput, ToolOutput } from "./tool";

function mockClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

describe("Tool copy actions", () => {
  it("copies serialized tool parameters", async () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);

    render(<ToolInput input={{ city: "Toronto", limit: 5 }} />);

    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify({ city: "Toronto", limit: 5 }, null, 2),
    );
  });

  it("copies the full serialized tool response", async () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);

    render(<ToolOutput output={{ result: "ok", count: 42 }} />);

    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify({ result: "ok", count: 42 }, null, 2),
    );
  });

  it("renders MCP app iframe when output contains mcp app URL metadata", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });

    render(
      <ToolOutput
        output={{
          title: "n8n",
          _meta: { "mcp/www_url": "https://example.com/mcp-app" },
        }}
      />,
    );

    expect(screen.getByTitle("n8n")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open MCP App in new tab" }),
    ).toHaveAttribute("href", "https://example.com/mcp-app");
  });

  it("renders MCP app iframe when output contains embedded HTML", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });

    render(
      <ToolOutput
        output={{
          mcpApp: {
            title: "Embedded App",
            html: "<html><body><h1>Hello MCP</h1></body></html>",
          },
        }}
      />,
    );

    expect(screen.getByTitle("Embedded App")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open MCP App in new tab" }),
    ).not.toBeInTheDocument();
  });

  it("supports n8n-style MCP app payload via ui.url", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });

    render(
      <ToolOutput
        output={{
          ui: {
            title: "n8n MCP",
            description: "workflow picker",
            url: "https://n8n.example.com/mcp/apps/workflow-picker",
          },
        }}
      />,
    );

    expect(screen.getByTitle("n8n MCP")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open MCP App in new tab" }),
    ).toHaveAttribute("href", "https://n8n.example.com/mcp/apps/workflow-picker");
  });

  it("supports excalidraw-style MCP app payload via mcpApp.url", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });

    render(
      <ToolOutput
        output={{
          mcpApp: {
            title: "Excalidraw MCP",
            description: "diagram editor",
            url: "https://excalidraw.example.com/mcp-app",
          },
        }}
      />,
    );

    expect(screen.getByTitle("Excalidraw MCP")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open MCP App in new tab" }),
    ).toHaveAttribute("href", "https://excalidraw.example.com/mcp-app");
  });
});
