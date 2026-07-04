import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  McpAppFullscreenExitButton,
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
    render(<McpAppStandaloneButton appId="app-123" />);

    const link = screen.getByRole("link", { name: /open in new tab/i });
    expect(link).toHaveAttribute("href", "/a/app-123");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("fires onClick when the fullscreen-exit button is pressed", async () => {
    const onClick = vi.fn();
    render(<McpAppFullscreenExitButton onClick={onClick} />);

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
