import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  McpAppFullscreenExitButton,
  McpAppMarkerCircle,
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

describe("McpAppMarkerCircle", () => {
  it("labels the marker with the app name without mounting an iframe", () => {
    const { container } = render(
      <McpAppMarkerCircle label="Dashboard" onClick={() => {}} />,
    );

    expect(
      screen.getByRole("button", { name: "Dashboard" }),
    ).toBeInTheDocument();
    expect(container.querySelector("iframe")).not.toBeInTheDocument();
  });

  it("fires onClick when pressed (opens the app in the panel)", async () => {
    const onClick = vi.fn();
    render(<McpAppMarkerCircle label="Dashboard" onClick={onClick} />);

    await userEvent.click(screen.getByRole("button", { name: "Dashboard" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
