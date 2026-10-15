import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { UninstallServerDialog } from "./uninstall-server-dialog";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useDeleteMcpServer: () => ({ mutateAsync: vi.fn(), isPending: true }),
}));

/** An admin sees shared installations and everyone's agents; a member neither. */
function viewAs(role: "admin" | "member") {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: role === "admin",
  } as ReturnType<typeof useHasPermissions>);
}

const personalInstall = {
  server: { id: "srv-1", name: "Notes", scope: "personal" as const },
  assignedAgents: [
    {
      id: "a1",
      name: "My Gateway",
      scope: "personal",
      ownerEmail: "member@example.com",
      pinned: true,
    },
  ],
};

describe("UninstallServerDialog", () => {
  beforeEach(() => viewAs("admin"));

  it("tells a member only what they can act on: no shared connections, no owners", () => {
    viewAs("member");
    render(
      <UninstallServerDialog
        open
        onClose={vi.fn()}
        installs={[personalInstall]}
      />,
    );

    expect(
      screen.getByText('Are you sure you want to uninstall "Notes"?'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/team and organization/)).toBeNull();
    expect(
      screen.getByText(/^My Gateway has tools assigned/),
    ).toBeInTheDocument();
  });

  it("tells an admin which connections stay and whose agents are affected", () => {
    render(
      <UninstallServerDialog
        open
        onClose={vi.fn()}
        installs={[personalInstall]}
      />,
    );

    expect(
      screen.getByText(/team and organization connections are not affected/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/^My Gateway \(member@example\.com\) has tools/),
    ).toBeInTheDocument();
  });

  it("keeps the server name while the uninstall removes it from the list", () => {
    const { rerender } = render(
      <UninstallServerDialog
        open
        onClose={vi.fn()}
        installs={[{ server: { id: "srv-1", name: "Slack" } }]}
      />,
    );

    rerender(<UninstallServerDialog open onClose={vi.fn()} installs={[]} />);

    expect(screen.getByText(/uninstall "Slack"\?/)).toBeInTheDocument();
  });
});
