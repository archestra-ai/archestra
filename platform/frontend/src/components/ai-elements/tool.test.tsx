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
});
