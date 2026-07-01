import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the runtime (sandboxed iframe + bridge) so the frame is tested in
// isolation — the iframe lifecycle is covered by mcp-app-container.test.tsx.
vi.mock("@/components/mcp-app/mcp-app-view", () => ({
  McpAppRuntime: ({
    toolResourceUri,
    appVersion,
  }: {
    toolResourceUri: string;
    appVersion?: number;
  }) => (
    <div
      data-testid="runtime"
      data-uri={toolResourceUri}
      data-version={appVersion ?? ""}
    />
  ),
  isRenderableMcpAppHtml: () => true,
}));

vi.mock("@/lib/app.query", () => ({ useApp: vi.fn() }));

import { useApp } from "@/lib/app.query";
import { AppFrame } from "./app-frame";

const mockUseApp = vi.mocked(useApp);

describe("AppFrame", () => {
  beforeEach(() => {
    mockUseApp.mockReturnValue({ data: undefined } as ReturnType<
      typeof useApp
    >);
  });

  it("renders the runtime for an external server using the provided resource uri", () => {
    render(
      <AppFrame
        endpoint={{ kind: "server", mcpServerId: "server-1" }}
        resourceUri="ui://external/app"
      />,
    );

    expect(screen.getByTestId("runtime")).toHaveAttribute(
      "data-uri",
      "ui://external/app",
    );
  });

  it("derives the resource uri and head version for an owned app", () => {
    mockUseApp.mockReturnValue({
      data: { latestVersion: 3 },
    } as ReturnType<typeof useApp>);

    render(<AppFrame endpoint={{ kind: "app", appId: "app-1" }} />);

    const runtime = screen.getByTestId("runtime");
    expect(runtime).toHaveAttribute("data-version", "3");
    // The resource URI is derived from the app id.
    expect(runtime.getAttribute("data-uri")).toContain("app-1");
  });
});
