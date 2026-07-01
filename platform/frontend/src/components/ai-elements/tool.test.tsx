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

  it("renders a multi-line string parameter as its own block with the raw value", async () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);

    render(<ToolInput input={{ command: "echo hi\necho bye", cwd: "/tmp" }} />);

    // per-field blocks instead of one JSON dump with escaped \n
    expect(screen.getByText("echo hi")).toBeInTheDocument();
    expect(screen.getByText("echo bye")).toBeInTheDocument();
    expect(screen.queryByText(/\\n/)).not.toBeInTheDocument();

    // the field copy button copies the raw string, not JSON
    const copyButtons = screen.getAllByRole("button", {
      name: "Copy to clipboard",
    });
    await user.click(copyButtons[0]);

    expect(writeText).toHaveBeenCalledWith("echo hi\necho bye");
  });

  it("renders MCP tool output using content instead of dumping rawContent metadata", async () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);

    render(
      <ToolOutput
        output={{
          content: "ARCH_TEST = asdfasdfadsf",
          unsafeContextBoundary: {
            kind: "tool_result",
            reason: "tool_result_marked_untrusted",
            toolCallId: "call-1",
            toolName: "test_tool",
          },
          rawContent: [{ type: "text", text: "ARCH_TEST = asdfasdfadsf" }],
          _meta: {
            ignored: true,
          },
        }}
      />,
    );

    expect(screen.getByText("ARCH_TEST = asdfasdfadsf")).toBeInTheDocument();
    expect(screen.queryByText(/rawContent/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    expect(writeText).toHaveBeenCalledWith("ARCH_TEST = asdfasdfadsf");
  });
});
