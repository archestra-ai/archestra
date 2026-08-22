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
});
