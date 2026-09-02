import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LogConsole } from "@/components/log-console";

vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn() }));

describe("LogConsole", () => {
  it("renders log text, the error instead of it, and the placeholder when neither", () => {
    const { rerender } = render(<LogConsole content={"line one\nline two"} />);
    expect(screen.getByText(/line one/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy/i })).toBeEnabled();

    rerender(<LogConsole content="" error="Error loading logs: nope" />);
    expect(screen.getByText("Error loading logs: nope")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy/i })).toBeDisabled();

    rerender(<LogConsole content="" placeholder={<span>Streaming…</span>} />);
    expect(screen.getByText("Streaming…")).toBeInTheDocument();

    rerender(<LogConsole content={null} emptyMessage="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });

  /**
   * An empty console is a large dark panel. One line of mono text in its top
   * corner reads as a rendering failure, so the empty state says what happened
   * and why, together, in the middle of the space it is explaining.
   */
  it("explains an empty console rather than stranding a single line", () => {
    render(
      <LogConsole
        content={null}
        emptyMessage="No output recorded"
        emptyHint="This execution ended without writing anything to its log."
      />,
    );

    expect(screen.getByText("No output recorded")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This execution ended without writing anything to its log.",
      ),
    ).toBeInTheDocument();
  });

  it("lets a caller's own placeholder replace the empty state", () => {
    render(
      <LogConsole
        content={null}
        emptyMessage="No output recorded"
        emptyHint="Should not be shown"
        placeholder={<span>Connecting to pod logs…</span>}
      />,
    );

    expect(screen.getByText("Connecting to pod logs…")).toBeInTheDocument();
    expect(screen.queryByText("No output recorded")).not.toBeInTheDocument();
    expect(screen.queryByText("Should not be shown")).not.toBeInTheDocument();
  });
});
