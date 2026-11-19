import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { RemoteServerInstallDialog } from "./remote-server-install-dialog";

vi.mock("@/lib/environment.query", () => ({
  useEnvironments: () => ({ data: { environments: [] } }),
}));
vi.mock("@/lib/organization.query", () => ({
  useDefaultEnvironment: () => ({
    name: "Default",
    validationRegex: null,
  }),
}));
vi.mock("./select-mcp-server-credential-type-and-teams", () => ({
  SelectMcpServerCredentialTypeAndTeams: () => <div>Personal connection</div>,
}));

describe("RemoteServerInstallDialog", () => {
  it("keeps a failed install open and reveals diagnostics on request", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onConfirm = vi
      .fn()
      .mockResolvedValueOnce(
        "Upstream MCP server returned HTTP 401 (invalid_token) while listing tools.",
      )
      .mockResolvedValueOnce(undefined);
    const catalogItem = {
      id: "server-1",
      name: "Mail server",
      userConfig: {},
      oauthConfig: null,
      environmentId: null,
    } as NonNullable<
      ComponentProps<typeof RemoteServerInstallDialog>["catalogItem"]
    >;

    render(
      <RemoteServerInstallDialog
        isOpen
        onClose={onClose}
        onConfirm={onConfirm}
        catalogItem={catalogItem}
        isInstalling={false}
        presentation="inline"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Install" }));
    expect(await screen.findByText("Connection failed")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText(/invalid_token/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show diagnostics" }));
    expect(screen.getByText(/HTTP 401 \(invalid_token\)/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
