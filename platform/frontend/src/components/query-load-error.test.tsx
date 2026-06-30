import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QueryLoadError } from "./query-load-error";

describe("QueryLoadError", () => {
  it("renders the given title and calls onRetry when the retry button is clicked", async () => {
    const onRetry = vi.fn();
    render(
      <QueryLoadError title="Custom load error title" onRetry={onRetry} />,
    );

    expect(screen.getByText("Custom load error title")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("exposes the retry button under the provided test id", () => {
    render(
      <QueryLoadError title="t" onRetry={vi.fn()} retryTestId="my-retry-id" />,
    );

    expect(screen.getByTestId("my-retry-id")).toBeInTheDocument();
  });
});
