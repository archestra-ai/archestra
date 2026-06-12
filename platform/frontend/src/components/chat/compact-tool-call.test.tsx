import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIsToolName = vi.fn();

vi.mock("@/lib/mcp/archestra-mcp-server", () => ({
  useArchestraMcpIdentity: () => ({
    isToolName: mockIsToolName,
  }),
}));

vi.mock("@/components/mcp-catalog-icon", () => ({
  McpCatalogIcon: ({
    catalogId,
  }: {
    catalogId?: string;
    icon?: string | null;
    size?: number;
  }) => <div data-testid="mcp-catalog-icon">{catalogId}</div>,
}));

import { CompactToolGroup } from "./compact-tool-call";

describe("CompactToolGroup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the built-in MCP icon when the icon map temporarily lacks built-in tool metadata", () => {
    mockIsToolName.mockImplementation(
      (toolName: string) => toolName === "sparky__get_mcp_servers",
    );

    render(
      <CompactToolGroup
        tools={[
          {
            kind: "tool",
            key: "tool-1",
            toolName: "sparky__get_mcp_servers",
            part: {
              type: "tool-sparky__get_mcp_servers",
              state: "output-available",
              toolCallId: "call-1",
              input: {},
              output: { ok: true },
            },
            toolResultPart: null,
            errorText: undefined,
          },
        ]}
        toolIconMap={new Map()}
      />,
    );

    expect(screen.getByTestId("mcp-catalog-icon")).toHaveTextContent(
      "00000000-0000-4000-8000-000000000001",
    );
  });

  it("renders a hook entry as a circle and expands its card on click", async () => {
    mockIsToolName.mockReturnValue(false);

    render(
      <CompactToolGroup
        tools={[
          {
            kind: "hook",
            key: "hook-1",
            data: {
              hookEventName: "PreToolUse",
              fileName: "guard.py",
              outcome: "proceeded",
              exitCode: 0,
            },
          },
        ]}
        toolIconMap={new Map()}
      />,
    );

    // collapsed: just the circle, no expanded card
    expect(screen.queryByTestId("hook-run-chip")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));

    expect(await screen.findByTestId("hook-run-chip")).toHaveTextContent(
      "PreToolUse",
    );
  });
});
