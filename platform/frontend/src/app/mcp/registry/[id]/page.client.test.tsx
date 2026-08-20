import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/config/config.query");

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useHasPermissions,
  useMissingPermissions,
  useSession,
} from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { McpCatalogItemPage } from "./page.client";

// The overview is a small part of a page that pulls in install dialogs,
// logs and inspectors. Each query module is mocked with the answers this
// test needs and a quiet fallback for whatever its children reach for, so a
// new hook somewhere below does not fail an unrelated assertion.
// `vi.mock` factories are hoisted above module scope, so the helper they
// close over is hoisted with them. Every export of these two query modules is
// stubbed — the overview is one part of a page whose install dialogs, logs
// and inspectors reach for the rest — and the handful this test depends on
// are given real answers.
const { useInternalMcpCatalog, stubs } = vi.hoisted(() => {
  const quiet = () => ({
    data: undefined,
    isPending: false,
    mutate: () => {},
    mutateAsync: async () => {},
  });
  const stubbed = (names: string[], overrides: Record<string, unknown>) =>
    Object.fromEntries(
      names.map((name) => [name, overrides[name] ?? quiet]),
    ) as Record<string, unknown>;
  return { useInternalMcpCatalog: vi.fn(), stubs: stubbed };
});

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  REMOTE_SERVER_URL_NOT_ALLOWED_CODE: "remote_server_url_not_allowed",
  CATALOG_NAME_CONFLICT_CODE: "catalog_name_conflict",
  getCatalogMutationErrorCode: () => undefined,
  ...stubs(
    [
      "useInternalMcpCatalog",
      "useMcpCatalogLabelKeys",
      "useMcpCatalogLabelValues",
      "useCreateInternalMcpCatalogItem",
      "useApproveCatalogItemImage",
      "useUpdateInternalMcpCatalogItem",
      "useReinstallInternalMcpCatalogItem",
      "useRefreshInternalMcpCatalogImage",
      "useDeleteInternalMcpCatalogItem",
      "useCatalogTools",
      "useGetDeploymentYamlPreview",
      "useValidateDeploymentYaml",
      "useResetDeploymentYaml",
      "useK8sImagePullSecrets",
    ],
    {
      useInternalMcpCatalog: (...args: unknown[]) =>
        useInternalMcpCatalog(...args),
      useCatalogTools: () => ({ data: [], isPending: false }),
    },
  ),
}));

vi.mock("@/lib/mcp/mcp-server.query", () =>
  stubs(
    [
      "useMcpServers",
      "useAutoModeAgents",
      "useMcpInstallationStatusCacheSync",
      "useMcpServersGroupedByCatalog",
      "useInstallMcpServer",
      "useDeleteMcpServer",
      "useReloadMcpServerTools",
      "useMcpServerTools",
      "useMcpServerInstallationStatus",
      "useReauthenticateMcpServer",
      "useReinstallMcpServer",
      "useMcpDeploymentStatuses",
    ],
    {
      useMcpServers: () => ({ data: [] }),
      useAutoModeAgents: () => ({ data: [] }),
      useMcpDeploymentStatuses: () => ({ data: {} }),
      useMcpInstallationStatusCacheSync: () => {},
    },
  ),
);

vi.mock("@/lib/mcp/use-mcp-server-issues", () => ({
  useMcpServerIssues: () => ({ issuesByCatalog: new Map() }),
}));
vi.mock("@/lib/environment.query", () => ({ useEnvironments: () => ({}) }));
vi.mock("@/lib/organization.query", () => ({
  useDefaultEnvironment: () => ({ name: "Default" }),
  useOrganization: () => ({ data: null }),
}));
vi.mock("@/lib/auth/identity-provider-read.query", () => ({
  useIdentityProviders: () => ({ data: [] }),
}));
vi.mock("../_parts/catalog-edit-access", () => ({
  useCanModifyCatalogItem: () => ({ canModify: true, isLoading: false }),
}));
vi.mock("../_parts/mcp-server-agent-usage", () => ({
  deriveAgentUsage: () => ({ agents: [], count: 0 }),
  McpServerAgentUsage: () => null,
}));

const localItem = {
  id: "cat-1",
  name: "internal-tools",
  description: "Team utilities",
  serverType: "local",
  multitenant: false,
  scope: "org",
  teams: [],
  labels: [],
  authorId: "u1",
  authorName: "Admin",
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-18T10:00:00.000Z",
  environmentId: null,
  toolCount: 0,
  localConfig: {
    command: "sh",
    // The API shape: a real array. The wizard's form shape joins these into
    // one newline-separated string, which is why the page must not use it.
    arguments: ["-c", "node server.js --port 8080"],
    transportType: "stdio",
    environment: [
      {
        key: "API_TOKEN",
        type: "secret",
        promptOnInstallation: true,
        required: true,
      },
      {
        key: "LOG_LEVEL",
        type: "string",
        promptOnInstallation: false,
        value: "info",
      },
    ],
    envFrom: [{ type: "secret", name: "shared-creds" }],
  },
};

function renderPage(overrides: Record<string, unknown> = {}) {
  useInternalMcpCatalog.mockReturnValue({
    data: [{ ...localItem, ...overrides }],
    isPending: false,
  });
  // Some of the page's children query directly; the page's own reads are
  // mocked above, so this client never fetches.
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <McpCatalogItemPage id="cat-1" />
    </QueryClientProvider>,
  );
}

function section(name: string) {
  const heading = screen.getByRole("heading", { name });
  const root = heading.closest("section");
  if (!root) throw new Error(`No section around "${name}"`);
  return within(root);
}

describe("McpCatalogItemDetailPage overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/mcp/registry/cat-1");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useAppName).mockReturnValue("Archestra");
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "u1" } },
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as unknown as ReturnType<typeof useHasPermissions>);
    vi.mocked(useMissingPermissions).mockReturnValue({});
  });

  it("reads the command as one runnable line, from the API's argument array", () => {
    renderPage();

    const connection = section("Connection");
    // Joined with spaces — reading the wizard's textarea shape here would
    // spread the string into one character per argument.
    expect(
      connection.getByText("sh -c node server.js --port 8080"),
    ).toBeInTheDocument();
    expect(
      connection.getByRole("button", { name: /copy/i }),
    ).toBeInTheDocument();
  });

  it("shows the deployment facts the wizard asks for", () => {
    renderPage();

    const connection = section("Connection");
    expect(connection.getByText(/Single-tenant/)).toBeInTheDocument();
    expect(connection.getByText("stdio")).toBeInTheDocument();
    expect(connection.getByText("Generated")).toBeInTheDocument();
  });

  it("names the environment variables, split by when they are supplied", () => {
    renderPage();

    const environment = section("Environment");
    expect(environment.getByText("Asked at installation")).toBeInTheDocument();
    expect(environment.getByText("API_TOKEN")).toBeInTheDocument();
    expect(environment.getByText("Set on the server")).toBeInTheDocument();
    expect(environment.getByText("LOG_LEVEL")).toBeInTheDocument();
    expect(environment.getByText("From Kubernetes")).toBeInTheDocument();
    expect(environment.getByText("shared-creds")).toBeInTheDocument();
  });

  it("says how callers authenticate, and never shows a secret's value", () => {
    renderPage({
      serverType: "remote",
      serverUrl: "https://tools.example.com/mcp",
      localConfig: null,
      oauthConfig: {
        grantType: "authorization_code",
        client_id: "abc123",
        tokenEndpoint: "https://auth.example.com/token",
        client_secret: "shhh",
        scopes: ["read", "write"],
      },
    });

    const auth = section("Authentication");
    expect(auth.getByText("OAuth 2.1")).toBeInTheDocument();
    expect(auth.getByText("abc123")).toBeInTheDocument();
    expect(auth.getByText("Configured")).toBeInTheDocument();
    expect(auth.queryByText("shhh")).toBeNull();
  });

  it("shows each team's access level, which the visibility badge cannot", () => {
    renderPage({
      scope: "team",
      teams: [
        { id: "t1", name: "Platform", level: "write" },
        { id: "t2", name: "Support", level: "use" },
      ],
    });

    const teams = screen.getByText("Teams").parentElement as HTMLElement;
    expect(within(teams).getByText("Platform")).toBeInTheDocument();
    expect(within(teams).getByText("Manage")).toBeInTheDocument();
    expect(within(teams).getByText("Support")).toBeInTheDocument();
    expect(within(teams).getByText("Use")).toBeInTheDocument();
  });

  it("credits the author and the last change", () => {
    renderPage();
    // The author and date are separate spans inside the one field.
    const created = screen.getByText("Created").parentElement as HTMLElement;
    expect(created).toHaveTextContent(/by Admin on/);
    expect(screen.getByText("Last updated")).toBeInTheDocument();
  });
});
