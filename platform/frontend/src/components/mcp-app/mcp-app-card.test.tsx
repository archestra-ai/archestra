import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { McpAppCard } from "./mcp-app-card";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const baseProps = {
  onToggleFullscreen: () => {},
  size: null,
  inlineCeiling: 1000,
  actions: [],
};

describe("McpAppCard bottom bar", () => {
  it("links the app version to the app page", () => {
    render(
      <McpAppCard
        {...baseProps}
        displayMode="inline"
        appId="app-123"
        appVersion={3}
      >
        <div>app body</div>
      </McpAppCard>,
    );

    const versionLink = screen.getByRole("link", { name: /version 3/i });
    expect(versionLink).toHaveAttribute("href", "/apps/app-123");
  });

  it("omits the bottom bar when no owned-app version is present", () => {
    render(
      <McpAppCard {...baseProps} displayMode="inline">
        <div>app body</div>
      </McpAppCard>,
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("hides the bottom bar for the placeholder stand-in", () => {
    render(
      <McpAppCard
        {...baseProps}
        displayMode="inline"
        appId="app-123"
        appVersion={3}
        placeholder={<span>Open in the side panel</span>}
      />,
    );

    expect(
      screen.queryByRole("link", { name: /version/i }),
    ).not.toBeInTheDocument();
  });
});
