import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

// Stub the runtime (sandboxed iframe + bridge) so the frame is tested in
// isolation — the iframe lifecycle is covered by mcp-app-container.test.tsx.
vi.mock("@/components/mcp-app/mcp-app-view", () => ({
  McpAppRuntime: () => <div data-testid="runtime" />,
  isRenderableMcpAppHtml: () => true,
}));

vi.mock("@/lib/app.query", () => ({ useApp: vi.fn() }));

import { useApp } from "@/lib/app.query";
import { AppFrame } from "./app-frame";
import { McpAppStandaloneButton } from "./mcp-app-chrome";

const mockUseApp = vi.mocked(useApp);

describe("AppFrame", () => {
  it("renders a bare runtime with no card chrome for external servers", () => {
    mockUseApp.mockReturnValue({ data: undefined } as ReturnType<
      typeof useApp
    >);

    render(
      <AppFrame
        endpoint={{ kind: "server", mcpServerId: "server-1" }}
        resourceUri="ui://external/app"
        chrome={false}
      />,
    );

    expect(screen.getByTestId("runtime")).toBeInTheDocument();
    // No address pill: no reload button, no version link.
    expect(
      screen.queryByRole("button", { name: /reload app/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /version/i }),
    ).not.toBeInTheDocument();
  });

  it("wraps owned apps in card chrome with label, version bar, and composed actions", () => {
    mockUseApp.mockReturnValue({
      data: { name: "Dashboard", latestVersion: 3 },
    } as ReturnType<typeof useApp>);

    render(
      <AppFrame
        endpoint={{ kind: "app", appId: "app-1" }}
        fillContainer
        actions={<McpAppStandaloneButton appId="app-1" />}
      />,
    );

    expect(screen.getByTestId("runtime")).toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /reload app/i }),
    ).toBeInTheDocument();
    // Version bar links to the detail page.
    expect(screen.getByRole("link", { name: /version 3/i })).toHaveAttribute(
      "href",
      "/apps/app-1",
    );
    // The caller-composed action button is rendered.
    expect(
      screen.getByRole("link", { name: /open standalone/i }),
    ).toHaveAttribute("href", "/a/app-1");
  });

  it("waits for the owned app to resolve before mounting the runtime", () => {
    mockUseApp.mockReturnValue({ data: undefined } as ReturnType<
      typeof useApp
    >);

    render(<AppFrame endpoint={{ kind: "app", appId: "app-1" }} />);

    expect(screen.queryByTestId("runtime")).not.toBeInTheDocument();
  });
});
