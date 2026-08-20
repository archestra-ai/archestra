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
import { useMcpServerIssues } from "@/lib/mcp/use-mcp-server-issues";
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
const {
  useInternalMcpCatalog,
  useMcpServers,
  useMcpDeploymentStatuses,
  stubs,
} = vi.hoisted(() => {
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
  return {
    useInternalMcpCatalog: vi.fn(),
    useMcpServers: vi.fn(),
    useMcpDeploymentStatuses: vi.fn(),
    stubs: stubbed,
  };
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
      "useMuteMcpServerAlert",
      "useUnmuteMcpServerAlert",
    ],
    {
      useMcpServers: () => useMcpServers(),
      useAutoModeAgents: () => ({ data: [] }),
      useMcpDeploymentStatuses: () => useMcpDeploymentStatuses(),
      useMcpInstallationStatusCacheSync: () => {},
    },
  ),
);

vi.mock("@/lib/mcp/use-mcp-server-issues", () => ({
  useMcpServerIssues: vi.fn(() => ({ issuesByCatalog: new Map() })),
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

/** The card whose heading names it. Every card title is one rank. */
function section(name: string) {
  const heading = screen.getByRole("heading", { name });
  const root = heading.closest("section");
  if (!root) throw new Error(`No section around "${name}"`);
  return within(root);
}

/**
 * The href of the action in the named card's header, or null when it has none.
 * Matched on the header action's own test id rather than on "the first link in
 * the card": card bodies carry links too (the Connection card's hibernation
 * row has a "Learn more"), and DOM order is not a contract.
 */
function cardActionHref(name: string) {
  return (
    section(name).queryByTestId("card-action")?.getAttribute("href") ?? null
  );
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
    // Nothing wrong with the server unless a test says so — `clearAllMocks`
    // keeps implementations, so a per-test issue would otherwise leak into
    // every test after it.
    vi.mocked(useMcpServerIssues).mockReturnValue({
      issuesByCatalog: new Map(),
    } as unknown as ReturnType<typeof useMcpServerIssues>);
    // Nothing installed and a live Kubernetes feed, unless a test says so.
    useMcpServers.mockReturnValue({ data: [] });
    useMcpDeploymentStatuses.mockReturnValue({ statuses: {}, state: "ready" });
  });

  /** One installed connection for this catalog entry, with no pod reported. */
  function installedWithNoDeploymentEntry() {
    useMcpServers.mockReturnValue({
      data: [
        {
          id: "srv-1",
          catalogId: "cat-1",
          serverType: "local",
          ownerId: "u1",
          teamId: null,
          createdAt: "2026-08-02T10:00:00.000Z",
        },
      ],
    });
  }

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

    const environment = section("Environment variables");
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

  it("closes with the record itself: id, dates and owner, and no way to edit it", () => {
    renderPage();

    const details = section("Details");
    expect(details.getByText("cat-1")).toBeInTheDocument();
    expect(
      details.getByRole("button", { name: /copy to clipboard/i }),
    ).toBeInTheDocument();
    expect(details.getByText("Created")).toBeInTheDocument();
    expect(details.getByText("Last updated")).toBeInTheDocument();
    expect(details.getByText("Admin")).toBeInTheDocument();
    // The catalog row records when it changed, never by whom.
    expect(details.queryByText(/updated by/i)).toBeNull();
    expect(cardActionHref("Details")).toBeNull();
  });

  it("sends each card to the wizard step that wrote what it shows", () => {
    renderPage();

    expect(cardActionHref("Connection")).toBe(
      "/mcp/registry/cat-1/edit?step=configuration",
    );
    expect(cardActionHref("Authentication")).toBe(
      "/mcp/registry/cat-1/edit?step=configuration",
    );
    expect(cardActionHref("Environment variables")).toBe(
      "/mcp/registry/cat-1/edit?step=configuration",
    );
    expect(cardActionHref("Tools")).toBe("/mcp/registry/cat-1/edit?step=tools");
    // Health is not the wizard's to write, but the step that re-tests it is
    // where a reader who wants to change the answer goes.
    expect(cardActionHref("Status")).toBe("/mcp/registry/cat-1/edit?step=test");
  });

  it("reads the status the way the registry list does, so the two cannot disagree", () => {
    // A remote connection whose token was rejected: a row exists, and it is
    // not working. Deriving the status from the row alone read "Connected"
    // with a green dot directly above the notice saying otherwise.
    vi.mocked(useMcpServerIssues).mockReturnValue({
      issuesByCatalog: new Map([
        [
          "cat-1",
          [
            {
              kind: "needs-reauth",
              severity: "down",
              audience: "you",
              catalogId: "cat-1",
              serverId: "srv-1",
              detail: "invalid_grant",
              since: null,
            },
          ],
        ],
      ]),
    } as unknown as ReturnType<typeof useMcpServerIssues>);
    renderPage({ serverType: "remote", localConfig: null });

    const status = section("Status");
    expect(status.getByText("Needs re-authentication")).toBeInTheDocument();
    expect(status.queryByText("Connected")).toBeNull();
    // An authentication fault is explained beside the authentication
    // configuration, not floating above the page.
    expect(status.queryByTestId(/mcp-registry-attention-row/)).toBeNull();
    expect(
      section("Authentication").getByTestId(
        "mcp-registry-attention-row-internal-tools",
      ),
    ).toBeInTheDocument();
  });

  it("reports the live fault, not the one the reader silenced", () => {
    // Issues are kind-ordered, and muting cuts across that order. Taking the
    // first issue made this page say "Failed to start" with a bell-off icon
    // while the registry list said "Needs re-authentication" for the same row.
    vi.mocked(useMcpServerIssues).mockReturnValue({
      issuesByCatalog: new Map([
        [
          "cat-1",
          [
            {
              kind: "failed-to-start",
              severity: "down",
              audience: "you",
              catalogId: "cat-1",
              serverId: "srv-1",
              detail: null,
              since: null,
              muted: true,
              mutedReason: null,
            },
            {
              kind: "needs-reauth",
              severity: "down",
              audience: "you",
              catalogId: "cat-1",
              serverId: "srv-2",
              detail: null,
              since: null,
              muted: false,
              mutedReason: null,
            },
          ],
        ],
      ]),
    } as unknown as ReturnType<typeof useMcpServerIssues>);
    renderPage();

    const status = section("Status");
    expect(status.getByText("Needs re-authentication")).toBeInTheDocument();
    expect(status.queryByText("Failed to start")).toBeNull();
  });

  it("does not claim a pod is running when no pod status has been reported", () => {
    installedWithNoDeploymentEntry();
    renderPage();

    // A green dot is a claim about a pod. With Kubernetes reachable and no
    // entry for this install, the honest answer is that the state is unknown.
    const status = section("Status");
    expect(status.getByText("Status unavailable")).toBeInTheDocument();
    expect(status.queryByText("Installed")).toBeNull();
  });

  it("says a remote server is installed, since it has no pod to be running", () => {
    installedWithNoDeploymentEntry();
    renderPage({ serverType: "remote", localConfig: null });

    expect(section("Status").getByText("Installed")).toBeInTheDocument();
  });

  it("says it is still checking while the deployment feed is loading", () => {
    installedWithNoDeploymentEntry();
    useMcpDeploymentStatuses.mockReturnValue({
      statuses: {},
      state: "loading",
    });
    renderPage();

    expect(section("Status").getByText("Checking…")).toBeInTheDocument();
  });

  it("names each card's Edit after the card, so five of them are not one set", () => {
    renderPage();

    // "Edit" alone, five times over, is unresolvable in a links list or to a
    // voice command.
    expect(
      screen.getByRole("link", { name: "Edit Connection" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Edit Tools" }),
    ).toBeInTheDocument();
  });

  it("says a built-in server is built in, rather than not installed", () => {
    renderPage({ serverType: "builtin", localConfig: null });

    expect(section("Status").getByText("Built-in")).toBeInTheDocument();
    expect(screen.queryByText("Not installed")).toBeNull();
  });
});
