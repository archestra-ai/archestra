import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { McpLogsContent } from "./mcp-logs-dialog";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/websocket/websocket", () => ({
  default: {
    connect: vi.fn(),
    isConnected: () => false,
    send: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  },
}));

const MINE = {
  id: "install-mine",
  name: "Orbit Tracker",
  ownerEmail: "me@example.com",
  teamDetails: null,
  scope: "personal" as const,
  canUseCredential: true,
};

function renderAs(managesInstallations: boolean) {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: managesInstallations,
  } as ReturnType<typeof useHasPermissions>);
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <McpLogsContent
        isActive
        serverName="Orbit Tracker"
        installs={[MINE]}
        deploymentStatuses={{}}
        hideHeader
      />
    </QueryClientProvider>,
  );
}

describe("diagnostics shell", () => {
  it("is offered only to someone who manages installations", () => {
    const { unmount } = renderAs(true);
    expect(screen.getByRole("tab", { name: "Shell" })).toBeInTheDocument();
    unmount();

    // A shell runs commands inside the server's container; a member's own
    // installation keeps its logs and inspector, without one.
    renderAs(false);
    expect(screen.queryByRole("tab", { name: "Shell" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Logs" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Inspector" })).toBeInTheDocument();
  });
});
