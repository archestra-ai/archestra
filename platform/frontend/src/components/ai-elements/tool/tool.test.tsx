import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { normalizeToolOutput } from "./tool-output.utils";

const { mockUseTheme } = vi.hoisted(() => ({
  mockUseTheme: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => mockUseTheme(),
}));

import { Tool } from "@/components/ai-elements/tool";

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

    render(<Tool.Input input={{ city: "Toronto", limit: 5 }} />);

    await user.click(screen.getByText("Parameters"));

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

    render(<Tool.Output output={{ result: "ok", count: 42 }} />);

    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify({ result: "ok", count: 42 }, null, 2),
    );
  });

  it("renders MCP tool output using content instead of dumping rawContent metadata", async () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);

    render(
      <Tool.Output
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

describe("normalizeToolOutput", () => {
  it("uses MCP content before raw metadata", () => {
    expect(
      normalizeToolOutput({
        content: "visible content",
        rawContent: [{ type: "text", text: "metadata" }],
      }),
    ).toBe("visible content");
  });

  it("uses structured content when MCP content is absent", () => {
    expect(
      normalizeToolOutput({
        structuredContent: { result: "ok" },
        rawContent: [{ type: "text", text: "metadata" }],
      }),
    ).toEqual({ result: "ok" });
  });

  it("leaves plain output unchanged", () => {
    const output = { result: "ok", count: 42 };

    expect(normalizeToolOutput(output)).toBe(output);
    expect(normalizeToolOutput("plain text")).toBe("plain text");
  });
});
