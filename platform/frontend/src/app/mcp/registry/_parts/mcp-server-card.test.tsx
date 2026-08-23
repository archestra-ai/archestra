import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/teams/team.query");

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/mcp/registry",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/environment.query", () => ({
  useEnvironments: () => ({ data: { environments: [] } }),
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useReinstallInternalMcpCatalogItem: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/mcp/use-can-reauthenticate", () => ({
  useCanReauthenticate: () => () => false,
}));

vi.mock("./catalog-edit-access", () => ({
  useCanModifyCatalogItem: () => ({ canModify: false, isLoading: false }),
}));

vi.mock("./use-chat-with-catalog-item", () => ({
  useChatWithCatalogItem: () => ({ startChat: vi.fn(), isCreating: false }),
}));

const { useMcpServersMock } = vi.hoisted(() => ({
  useMcpServersMock: vi.fn(),
}));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServers: useMcpServersMock,
  useAutoModeAgents: () => ({ data: [] }),
  useDeleteMcpServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import type { Permissions } from "@archestra/shared";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  useAppearanceSettings,
  useDefaultEnvironment,
} from "@/lib/organization.query";
import { useAssignableTeams } from "@/lib/teams/team.query";
import {
  type CatalogItem,
  type InstalledServer,
  McpServerCard,
} from "./mcp-server-card";

const CURRENT_USER_ID = "user-me";

const item = {
  id: "cat-1",
  name: "some-remote-server",
  serverType: "remote",
  icon: null,
  toolCount: 0,
  environmentId: null,
  oauthConfig: null,
  imageApprovalRequired: false,
  multitenant: false,
  catalogReinstallRequired: false,
} as unknown as CatalogItem;

const personalInstall = {
  id: "srv-1",
  catalogId: "cat-1",
  name: "some-remote-server",
  ownerId: CURRENT_USER_ID,
  teamId: null,
  serverType: "remote",
  reinstallRequired: false,
  assignedAgents: [],
  users: [CURRENT_USER_ID],
  createdAt: new Date().toISOString(),
} as unknown as InstalledServer;

const renderCard = (ui: ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );

/** Grant every permission except the ones named. */
const grantAllExcept = (denied: Permissions) => {
  const deniedKeys = Object.entries(denied).flatMap(([resource, actions]) =>
    (actions ?? []).map((action: string) => `${resource}:${action}`),
  );
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions: Permissions) =>
      ({
        data: !Object.entries(permissions ?? {}).some(([resource, actions]) =>
          (actions ?? []).some((action: string) =>
            deniedKeys.includes(`${resource}:${action}`),
          ),
        ),
      }) as unknown as ReturnType<typeof useHasPermissions>,
  );
};

const card = (
  <McpServerCard
    variant="remote"
    item={item}
    installingItemId={null}
    deploymentStatuses={{}}
    deploymentFeedState="ready"
    onInstallRemoteServer={vi.fn()}
    onInstallLocalServer={vi.fn()}
    onReinstall={vi.fn()}
  />
);

describe("McpServerCard uninstall permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: CURRENT_USER_ID } },
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useFeature).mockReturnValue(
      false as unknown as ReturnType<typeof useFeature>,
    );
    vi.mocked(useAssignableTeams).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useAssignableTeams>);
    vi.mocked(useAppearanceSettings).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useAppearanceSettings>);
    vi.mocked(useDefaultEnvironment).mockReturnValue({
      name: "Default",
    } as unknown as ReturnType<typeof useDefaultEnvironment>);
    useMcpServersMock.mockReturnValue({ data: [personalInstall] });
    grantAllExcept({});
  });

  it("opens the uninstall dialog for a user who may delete their connection", async () => {
    const user = userEvent.setup();
    renderCard(card);

    await user.click(screen.getByRole("button", { name: "Uninstall" }));

    expect(await screen.findByText("Uninstall MCP Server")).toBeInTheDocument();
  });

  it("refuses the uninstall for a user without the delete permission", async () => {
    // The 403 the delete call answers with is honest, but the control should
    // not have been offered: its Install and Reinstall siblings are gated the
    // same way.
    const user = userEvent.setup();
    grantAllExcept({ mcpServerInstallation: ["delete"] });
    renderCard(card);

    const uninstall = screen.getByRole("button", { name: /Uninstall/ });
    expect(uninstall).toHaveAttribute("aria-disabled", "true");

    await user.click(uninstall);

    expect(screen.queryByText("Uninstall MCP Server")).not.toBeInTheDocument();
  });

  it("hides OAuth failure diagnostics while MCP alerting is disabled", () => {
    useMcpServersMock.mockReturnValue({
      data: [
        {
          ...personalInstall,
          oauthRefreshError: "refresh_failed",
        },
      ],
    });
    renderCard(
      <McpServerCard
        variant="remote"
        item={{ ...item, oauthConfig: {} } as unknown as CatalogItem}
        installingItemId={null}
        deploymentStatuses={{}}
        deploymentFeedState="ready"
        onInstallRemoteServer={vi.fn()}
        onInstallLocalServer={vi.fn()}
        onReinstall={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("oauth-reauth-state")).toBeNull();
  });
});
