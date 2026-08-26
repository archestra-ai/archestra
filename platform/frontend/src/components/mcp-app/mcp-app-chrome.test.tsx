import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  McpAppFullscreenButton,
  McpAppPill,
  McpAppStandaloneButton,
} from "./mcp-app-chrome";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

describe("address-pill action buttons", () => {
  it("opens the owned app's standalone run page in a new tab", () => {
    render(<McpAppStandaloneButton app={{ id: "app-123" }} />);

    const link = screen.getByRole("link", { name: /open in new tab/i });
    expect(link).toHaveAttribute("href", "/a/app-123");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("addresses the app by its slug when it has one", () => {
    render(
      <McpAppStandaloneButton app={{ id: "app-123", slug: "sales-board" }} />,
    );

    expect(
      screen.getByRole("link", { name: /open in new tab/i }),
    ).toHaveAttribute("href", "/a/sales-board");
  });

  it("disables opening a new tab while a recording is in progress", () => {
    render(<McpAppStandaloneButton app={{ id: "app-123" }} disabled />);

    // No link to a fresh, unrecorded instance — just a disabled button.
    expect(
      screen.queryByRole("link", { name: /open in new tab/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /open in new tab/i }),
    ).toBeDisabled();
  });

  it("offers the way into fullscreen while the app is inline", async () => {
    const onClick = vi.fn();
    render(<McpAppFullscreenButton isFullscreen={false} onClick={onClick} />);

    await userEvent.click(
      screen.getByRole("button", { name: /enter fullscreen/i }),
    );
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("offers the way back out while the app is fullscreen", async () => {
    const onClick = vi.fn();
    render(<McpAppFullscreenButton isFullscreen onClick={onClick} />);

    await userEvent.click(
      screen.getByRole("button", { name: /exit fullscreen/i }),
    );
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("McpAppPill", () => {
  it("shows the app name inline without mounting an iframe", () => {
    const { container } = render(
      <McpAppPill label="Dashboard" onClick={() => {}} />,
    );

    const button = screen.getByRole("button", { name: "Dashboard" });
    // The name is visible pill text, not just a tooltip/aria label.
    expect(button).toHaveTextContent("Dashboard");
    expect(container.querySelector("iframe")).not.toBeInTheDocument();
  });

  it("toggles on click and reflects its pressed state", async () => {
    const onClick = vi.fn();
    render(<McpAppPill label="Dashboard" pressed onClick={onClick} />);

    const button = screen.getByRole("button", { name: "Dashboard" });
    expect(button).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
