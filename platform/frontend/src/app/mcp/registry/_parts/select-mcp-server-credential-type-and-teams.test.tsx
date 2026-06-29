import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SelectMcpServerCredentialTypeAndTeams } from "./select-mcp-server-credential-type-and-teams";

const CATALOG_ID = "cat-1";
const CURRENT_USER_ID = "user-1";

// A personal connection the current user already installed for this catalog.
const installedServers = [
  {
    id: "srv-1",
    catalogId: CATALOG_ID,
    scope: "personal",
    ownerId: CURRENT_USER_ID,
    teamId: null,
  },
];

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServers: () => ({ data: installedServers }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: CURRENT_USER_ID } } }),
  // Member role: no mcpServerInstallation:update and no :admin.
  useHasPermissions: () => ({ data: false }),
}));

vi.mock("@/lib/teams/team.query", () => ({
  useAssignableTeams: () => ({ data: [], isLoading: false }),
}));

describe("SelectMcpServerCredentialTypeAndTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks a fresh install when every scope is already taken", async () => {
    const onCanInstallChange = vi.fn();

    render(
      <SelectMcpServerCredentialTypeAndTeams
        onTeamChange={vi.fn()}
        catalogId={CATALOG_ID}
        onCanInstallChange={onCanInstallChange}
      />,
    );

    // Personal already installed, no team/org permission → nothing installable.
    await waitFor(() =>
      expect(onCanInstallChange).toHaveBeenLastCalledWith(false),
    );
    expect(screen.getByText("Already installed")).toBeInTheDocument();
  });

  it("lets the owner re-authenticate their existing personal connection", async () => {
    const onCanInstallChange = vi.fn();

    render(
      <SelectMcpServerCredentialTypeAndTeams
        onTeamChange={vi.fn()}
        catalogId={CATALOG_ID}
        onCanInstallChange={onCanInstallChange}
        isReauth
        existingScope="personal"
      />,
    );

    // Re-auth locks to the existing (personal) scope instead of disabling it,
    // so the connection stays editable and the dead-end notice is gone.
    await waitFor(() =>
      expect(onCanInstallChange).toHaveBeenLastCalledWith(true),
    );
    expect(screen.queryByText("Already installed")).not.toBeInTheDocument();
  });
});
