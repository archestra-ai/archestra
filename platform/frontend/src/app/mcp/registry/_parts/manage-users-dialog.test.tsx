import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import { useMyTeams } from "@/lib/teams/team.query";
import { ManageUsersContent } from "./manage-users-dialog";

const CATALOG_ID = "cat-1";
const CURRENT_USER_ID = "user-me";
const OTHER_USER_EMAIL = "teammate@example.com";

const myConnection = {
  id: "srv-mine",
  name: "My connection",
  catalogId: CATALOG_ID,
  catalogName: "Some MCP",
  scope: "personal",
  ownerId: CURRENT_USER_ID,
  ownerEmail: "me@example.com",
  teamId: null,
  teamDetails: null,
  secretStorageType: "database",
  createdAt: "2026-01-02T00:00:00.000Z",
};

const othersConnection = {
  ...myConnection,
  id: "srv-theirs",
  name: "Their connection",
  ownerId: "user-them",
  ownerEmail: OTHER_USER_EMAIL,
};

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/teams/team.query");

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServers: vi.fn(),
  useDeleteMcpServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useInternalMcpCatalog: () => ({
    data: [{ id: CATALOG_ID, name: "Some MCP", scope: "org", teams: [] }],
  }),
  useUpdateInternalMcpCatalogItem: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/oauth.query", () => ({
  useInitiateOAuth: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("./catalog-edit-access", () => ({
  useCanModifyCatalogItem: () => ({ canModify: true, isLoading: false }),
}));

vi.mock("./use-can-reauthenticate", () => ({
  useCanReauthenticate: () => () => false,
}));

function renderContent({
  canUseOthers,
  isInstallAdmin = false,
}: {
  canUseOthers: boolean;
  isInstallAdmin?: boolean;
}) {
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: CURRENT_USER_ID } },
    isPending: false,
  } as ReturnType<typeof useSession>);

  vi.mocked(useHasPermissions).mockImplementation(((perm: {
    credentialConnection?: string[];
    mcpServerInstallation?: string[];
  }) => ({
    data: perm.credentialConnection?.includes("use")
      ? canUseOthers
      : perm.mcpServerInstallation?.includes("admin")
        ? isInstallAdmin
        : false,
    isLoading: false,
  })) as unknown as typeof useHasPermissions);

  vi.mocked(useMyTeams).mockReturnValue({
    data: [],
    isLoading: false,
  } as unknown as ReturnType<typeof useMyTeams>);

  vi.mocked(useMcpServers).mockReturnValue({
    data: [myConnection, othersConnection],
    isFetched: true,
  } as unknown as ReturnType<typeof useMcpServers>);

  return render(
    <ManageUsersContent
      isActive
      onClose={() => {}}
      catalogId={CATALOG_ID}
      hideHeader
    />,
  );
}

describe("ManageUsersContent credential visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hides other users' personal connections without credentialConnection:use", () => {
    renderContent({ canUseOthers: false });

    expect(screen.getByText("me@example.com")).toBeInTheDocument();
    expect(screen.queryByText(OTHER_USER_EMAIL)).not.toBeInTheDocument();
  });

  it("shows other users' personal connections with credentialConnection:use", () => {
    renderContent({ canUseOthers: true });

    expect(screen.getByText("me@example.com")).toBeInTheDocument();
    expect(screen.getByText(OTHER_USER_EMAIL)).toBeInTheDocument();
  });

  it("install-admins see other users' connections without the use permission (backend bypass mirror)", () => {
    renderContent({ canUseOthers: false, isInstallAdmin: true });

    expect(screen.getByText("me@example.com")).toBeInTheDocument();
    expect(screen.getByText(OTHER_USER_EMAIL)).toBeInTheDocument();
  });
});
