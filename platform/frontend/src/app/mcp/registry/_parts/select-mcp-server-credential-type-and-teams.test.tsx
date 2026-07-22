import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { useAssignableTeams } from "@/lib/teams/team.query";
import { useCanModifyCatalogItem } from "./catalog-edit-access";
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

vi.mock("@/lib/mcp/internal-mcp-catalog.query");

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/teams/team.query");

vi.mock("./catalog-edit-access", () => ({
  useCanModifyCatalogItem: vi.fn(() => ({ canModify: true, isLoading: false })),
}));

describe("SelectMcpServerCredentialTypeAndTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: CURRENT_USER_ID } },
    } as ReturnType<typeof useSession>);
    // Member role: no mcpServerInstallation:update and no :admin.
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useAssignableTeams).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useAssignableTeams>);
    vi.mocked(useInternalMcpCatalog).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useInternalMcpCatalog>);
    vi.mocked(useCanModifyCatalogItem).mockReturnValue({
      canModify: true,
      isLoading: false,
    });
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

  describe("team-scoped catalog write gate", () => {
    const TEAM_CATALOG = {
      id: "cat-team",
      scope: "team",
      teams: [{ id: "t1", name: "Team One", level: "use" }],
      authorId: "someone-else",
    };

    beforeEach(() => {
      // Editor: has mcpServerInstallation:update (so the generic team gate
      // passes), but not :admin.
      vi.mocked(useHasPermissions).mockImplementation(((perm: {
        mcpServerInstallation?: string[];
      }) => ({
        data: Boolean(perm.mcpServerInstallation?.includes("update")),
      })) as unknown as typeof useHasPermissions);
      vi.mocked(useAssignableTeams).mockReturnValue({
        data: [{ id: "t1", name: "Team One" }],
        isLoading: false,
      } as unknown as ReturnType<typeof useAssignableTeams>);
      // The gate resolves the item from the catalog list by the id it is given.
      vi.mocked(useInternalMcpCatalog).mockReturnValue({
        data: [TEAM_CATALOG],
      } as unknown as ReturnType<typeof useInternalMcpCatalog>);
    });

    async function expandAndGetTeamOption() {
      const trigger = await screen.findByRole("button", { name: /Personal/i });
      trigger.click();
      return screen.findByRole("button", { name: /Team/i });
    }

    it("withholds the team option from a caller without write on the item", async () => {
      vi.mocked(useCanModifyCatalogItem).mockReturnValue({
        canModify: false,
        isLoading: false,
      });
      const onScopeChange = vi.fn();

      render(
        <SelectMcpServerCredentialTypeAndTeams
          onTeamChange={vi.fn()}
          catalogId="cat-team"
          onScopeChange={onScopeChange}
        />,
      );

      // Personal (own) install is still offered; the caller is steered there.
      await waitFor(() =>
        expect(onScopeChange).toHaveBeenLastCalledWith("personal"),
      );
      expect(await expandAndGetTeamOption()).toBeDisabled();
    });

    it("offers the team option to a caller who holds write on the item", async () => {
      vi.mocked(useCanModifyCatalogItem).mockReturnValue({
        canModify: true,
        isLoading: false,
      });

      render(
        <SelectMcpServerCredentialTypeAndTeams
          onTeamChange={vi.fn()}
          catalogId="cat-team"
          onScopeChange={vi.fn()}
        />,
      );

      expect(await expandAndGetTeamOption()).toBeEnabled();
    });

    it("does not withhold the team option while the write check is still loading", async () => {
      // A transient `canModify: false` during load must not steer a genuine
      // write-holder to personal — the option stays enabled until it resolves.
      vi.mocked(useCanModifyCatalogItem).mockReturnValue({
        canModify: false,
        isLoading: true,
      });

      render(
        <SelectMcpServerCredentialTypeAndTeams
          onTeamChange={vi.fn()}
          catalogId="cat-team"
          onScopeChange={vi.fn()}
        />,
      );

      expect(await expandAndGetTeamOption()).toBeEnabled();
    });
  });
});
