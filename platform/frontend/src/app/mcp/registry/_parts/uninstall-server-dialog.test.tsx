import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UninstallServerDialog } from "./uninstall-server-dialog";

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useDeleteMcpServer: () => ({ mutateAsync: vi.fn(), isPending: true }),
}));

describe("UninstallServerDialog", () => {
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
