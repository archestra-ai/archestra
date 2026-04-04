import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SetupDialog } from "./setup-dialog";

// embla-carousel needs matchMedia, ResizeObserver, IntersectionObserver as constructors
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.IntersectionObserver =
  MockIntersectionObserver as unknown as typeof IntersectionObserver;

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

describe("SetupDialog", () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    title: "Setup Slack",
    description: "Configure your Slack integration",
    steps: [
      <div key="s1">
        <label htmlFor="token-input">API Token</label>
        <input id="token-input" type="text" />
      </div>,
      <div key="s2">
        <label htmlFor="channel-input">Channel</label>
        <input id="channel-input" type="text" />
      </div>,
      <div key="s3">
        <p>All done</p>
      </div>,
    ],
  };

  it("renders the first step and step indicator", () => {
    render(<SetupDialog {...defaultProps} />);
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    expect(screen.getByLabelText("API Token")).toBeInTheDocument();
  });

  it("does not change step when pressing ArrowRight while focused on an input", async () => {
    const user = userEvent.setup();
    render(<SetupDialog {...defaultProps} />);

    const input = screen.getByLabelText("API Token");
    await user.click(input);
    await user.keyboard("{ArrowRight}");

    // Step should remain the same
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
  });

  it("disables the Back button on the first step", () => {
    render(<SetupDialog {...defaultProps} />);
    expect(screen.getByRole("button", { name: /back/i })).toBeDisabled();
  });

  it("renders Next button on non-last steps", () => {
    render(<SetupDialog {...defaultProps} />);
    expect(screen.getByRole("button", { name: /next/i })).toBeInTheDocument();
  });

  it("respects canProceed gating by disabling Next button", () => {
    render(<SetupDialog {...defaultProps} canProceed={(step) => step !== 0} />);

    const nextButton = screen.getByRole("button", { name: /next/i });
    expect(nextButton).toBeDisabled();
  });

  it("enables Next button when canProceed returns true", () => {
    render(<SetupDialog {...defaultProps} canProceed={() => true} />);

    const nextButton = screen.getByRole("button", { name: /next/i });
    expect(nextButton).toBeEnabled();
  });
});
