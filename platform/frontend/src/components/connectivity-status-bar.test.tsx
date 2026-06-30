import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectivityStatusBar } from "./connectivity-status-bar";

describe("ConnectivityStatusBar", () => {
  it("renders nothing while online", () => {
    const { container } = render(
      <ConnectivityStatusBar state={{ kind: "online" }} onRetry={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the bar for both non-online states, with distinct messages", () => {
    const { rerender } = render(
      <ConnectivityStatusBar
        state={{ kind: "browser-offline" }}
        onRetry={vi.fn()}
      />,
    );
    const browserOfflineText = screen.getByTestId(
      "connectivity-status-bar",
    ).textContent;
    expect(browserOfflineText).toBeTruthy();

    rerender(
      <ConnectivityStatusBar
        state={{ kind: "backend-unreachable" }}
        onRetry={vi.fn()}
      />,
    );
    const unreachableText = screen.getByTestId(
      "connectivity-status-bar",
    ).textContent;

    // The bar distinguishes the two failure modes rather than showing one
    // generic message.
    expect(unreachableText).not.toEqual(browserOfflineText);
  });

  it("calls onRetry when the retry button is clicked", async () => {
    const onRetry = vi.fn();
    render(
      <ConnectivityStatusBar
        state={{ kind: "backend-unreachable" }}
        onRetry={onRetry}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
