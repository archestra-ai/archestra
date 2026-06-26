import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  McpAppChangelogPill,
  McpAppFullscreenExitButton,
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

describe("McpAppChangelogPill", () => {
  it("shows the app name, version, and verb without mounting an iframe", () => {
    const { container } = render(
      <McpAppChangelogPill appName="Dashboard" version={2} verb="Updated" />,
    );

    expect(screen.getByText(/Dashboard · v2 · Updated/)).toBeInTheDocument();
    expect(container.querySelector("iframe")).not.toBeInTheDocument();
  });

  it("falls back to a generic label when name and verb are missing", () => {
    render(<McpAppChangelogPill appName={null} version={1} verb={null} />);

    expect(screen.getByText(/App · v1/)).toBeInTheDocument();
  });
});
