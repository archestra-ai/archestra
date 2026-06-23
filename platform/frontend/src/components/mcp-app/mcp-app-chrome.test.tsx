import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { McpAppChangelogPill, McpAppVersionBar } from "./mcp-app-chrome";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

describe("McpAppVersionBar", () => {
  it("links the app version to the app page", () => {
    render(<McpAppVersionBar appId="app-123" version={3} />);

    const versionLink = screen.getByRole("link", { name: /version 3/i });
    expect(versionLink).toHaveAttribute("href", "/apps/app-123");
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
