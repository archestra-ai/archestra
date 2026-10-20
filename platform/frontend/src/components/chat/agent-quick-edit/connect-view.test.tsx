import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { catalogs, servers, installMock } = vi.hoisted(() => ({
  catalogs: new Map<string, Record<string, unknown>>(),
  // Servers per catalog, as the server list answers after an install.
  servers: new Map<string, number>(),
  installMock: vi.fn(),
}));

vi.mock("@/lib/mcp/mcp-registry.query", () => ({
  fetchInternalMcpCatalogItem: async (_queryClient: unknown, id: string) =>
    catalogs.get(id) ?? null,
  useMcpRegistryIssueIndex: () => ({ data: { catalogItems: [], servers: [] } }),
  useMcpRegistryPage: () => ({ data: undefined, isPending: true }),
  useInternalMcpCatalogItem: () => ({ data: undefined }),
}));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useInstallMcpServer: () => ({ mutateAsync: installMock, isPending: false }),
  useReauthenticateMcpServer: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useMcpServers: () => ({ data: [] }),
  useMcpServersGroupedByCatalog: ({ catalogId }: { catalogId: string }) => ({
    [catalogId]: Array.from({ length: servers.get(catalogId) ?? 0 }),
  }),
}));

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  fetchCatalogTools: vi.fn(),
  useMcpCatalogCredentialPreflight: () => ({ data: [] }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: "user-1" } } }),
  useHasPermissions: () => ({ data: true }),
}));

vi.mock("@/lib/auth/oauth.query", () => ({
  useInitiateOAuth: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/lib/config/config.query", () => ({
  useFeature: () => false,
}));

vi.mock("@/lib/environment.query", () => ({
  useEnvironments: () => ({ data: { environments: [] } }),
}));

vi.mock("@/lib/organization.query", () => ({
  useDefaultEnvironment: () => ({ name: "Default", validationRegex: null }),
}));

vi.mock("@/lib/teams/team.query", () => ({
  useTeamsWithVaultFolders: () => ({ data: [] }),
}));

// Scope and team choice is its own form section, not what is under test.
vi.mock(
  "@/app/mcp/registry/_parts/select-mcp-server-credential-type-and-teams",
  () => ({ SelectMcpServerCredentialTypeAndTeams: () => null }),
);

vi.mock("@/lib/agent-tools.query", () => ({
  ServerToolsUpdateError: class extends Error {},
  useAllProfileTools: () => ({ data: { data: [] } }),
  useUpdateAgentServerTools: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/mcp/archestra-mcp-server", () => ({
  useArchestraMcpIdentity: () => ({ catalogName: "Archestra" }),
}));

vi.mock("@/components/mcp-catalog-icon", () => ({
  McpCatalogIcon: () => null,
}));

import type { CatalogItem } from "@/app/mcp/registry/_parts/mcp-server-card";
import { Dialog } from "@/components/ui/dialog";
import { useMcpInstallOrchestrator } from "@/lib/mcp/mcp-install-orchestrator.hook";
import { ConnectView } from "./add-tools-view";

const INSTALL_FORMS = ["remote-install", "local-install", "no-auth"] as const;

// The quick-edit's wiring: the connect view shows the installer's form inline,
// and every other view renders the same installer's forms as modals.
function QuickEdit({ catalog }: { catalog: CatalogItem }) {
  const installer = useMcpInstallOrchestrator();
  const [view, setView] = useState<"connect" | "add-tools" | "installing">(
    "connect",
  );
  const modalForms = INSTALL_FORMS.filter((form) =>
    installer.isDialogOpened(form),
  );
  return view === "connect" ? (
    <Dialog open>
      <ConnectView
        catalog={catalog}
        agentName="Agent"
        installer={installer}
        addWhenConnected
        onAddWhenConnectedChange={() => {}}
        onCancel={() => setView("add-tools")}
        onConnected={() => setView("installing")}
      />
    </Dialog>
  ) : (
    <div>
      <p>{view} view</p>
      <p>Modal install forms: {modalForms.join(", ") || "none"}</p>
    </div>
  );
}

function renderConnect(catalog: Record<string, unknown>) {
  catalogs.set(catalog.id as string, catalog);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <QuickEdit catalog={catalog as unknown as CatalogItem} />
    </QueryClientProvider>,
  );
}

const noAuthServer = {
  id: "catalog-fetch",
  name: "Fetch",
  serverType: "local",
  localConfig: { environment: [] },
};

const remoteServer = {
  id: "catalog-remote",
  name: "Remote Docs",
  serverType: "remote",
};

describe("ConnectView", () => {
  beforeEach(() => {
    catalogs.clear();
    servers.clear();
    installMock.mockReset();
    installMock.mockImplementation(async ({ catalogId }) => {
      servers.set(catalogId, 1);
      return { installedServer: { id: "server-1" } };
    });
  });

  it("leaves no install form behind when the user goes back", async () => {
    renderConnect(noAuthServer);
    await screen.findByRole("button", { name: "Install" });

    await userEvent.click(screen.getByRole("button", { name: /Add tools/ }));

    expect(screen.getByText("add-tools view")).toBeInTheDocument();
    expect(screen.getByText("Modal install forms: none")).toBeInTheDocument();
  });

  it("leaves no install form behind when the user cancels the form", async () => {
    renderConnect(remoteServer);
    await screen.findByRole("button", { name: "Install" });

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("add-tools view")).toBeInTheDocument();
    expect(screen.getByText("Modal install forms: none")).toBeInTheDocument();
  });

  it("moves on to installing, with no form left open, after a remote install", async () => {
    renderConnect(remoteServer);
    await userEvent.click(
      await screen.findByRole("button", { name: "Install" }),
    );

    expect(await screen.findByText("installing view")).toBeInTheDocument();
    expect(screen.getByText("Modal install forms: none")).toBeInTheDocument();
  });

  it("keeps the form for another try when the install was refused", async () => {
    // A refused install toasts its reason and creates no server.
    installMock.mockResolvedValue({ installedServer: undefined });
    renderConnect(remoteServer);
    await userEvent.click(
      await screen.findByRole("button", { name: "Install" }),
    );

    expect(
      await screen.findByRole("button", { name: "Install" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/view$/)).not.toBeInTheDocument();
  });
});
