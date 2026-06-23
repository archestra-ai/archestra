import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { McpAppVersionBar } from "./mcp-app-chrome";

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
