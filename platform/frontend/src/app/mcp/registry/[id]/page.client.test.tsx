import { PLAYWRIGHT_MCP_CATALOG_ID } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/config/config.query");

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useHasPermissions,
  useMissingPermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
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
  reauthenticateMutateAsync,
  deleteMutateAsync,
  useResourcePermissions,
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
    reauthenticateMutateAsync: vi.fn(),
    deleteMutateAsync: vi.fn(),
    useResourcePermissions: vi.fn(),
    stubs: stubbed,
  };
});

vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useMcpCatalogCredentialPreflight: () => ({ data: [] }),
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
      "useDismissMcpServerAlerts",
      "useRestoreMcpServerAlerts",
      "useMcpServersAssignedAgents",
    ],
    {
      useMcpServers: () => useMcpServers(),
      // Stands in for GET /api/mcp_server/:id, which returns the same install
      // with its agents.
      useMcpServersAssignedAgents: ({ serverIds }: { serverIds: string[] }) => {
        const servers: Array<{ id: string; assignedAgents?: unknown[] }> =
          useMcpServers()?.data ?? [];
        return {
          agentsByServerId: new Map(
            serverIds.map((id) => [
              id,
              servers.find((server) => server.id === id)?.assignedAgents ?? [],
            ]),
          ),
          isPending: false,
          isError: false,
        };
      },
      useAutoModeAgents: () => ({ data: [] }),
      useMcpDeploymentStatuses: () => useMcpDeploymentStatuses(),
      useMcpInstallationStatusCacheSync: () => {},
      useReauthenticateMcpServer: () => ({
        mutateAsync: reauthenticateMutateAsync,
        isPending: false,
      }),
      useDeleteMcpServer: () => ({
        mutateAsync: deleteMutateAsync,
        isPending: false,
      }),
    },
  ),
);

vi.mock("@/lib/resource-permissions.query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/resource-permissions.query")
  >()),
  useResourcePermissions: (...args: unknown[]) =>
    useResourcePermissions(...args),
}));

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

const localItem = {
  id: "cat-1",
  effectiveActions: ["read", "use", "update", "delete", "manage-permissions"],
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
  const result = render(
    <QueryClientProvider client={new QueryClient()}>
      <McpCatalogItemPage id={String(overrides.id ?? "cat-1")} />
    </QueryClientProvider>,
  );
  return result;
}

/** The card whose heading names it. Every card title is one rank. */
function section(name: string) {
  const heading = screen.getByRole("heading", { name });
  const root = heading.closest("section");
  if (!root) throw new Error(`No section around "${name}"`);
  return within(root);
}

describe("McpCatalogItemDetailPage overview", () => {
  beforeEach(() => {
    vi.mocked(useScopedCapabilities).mockReturnValue({
      data: [
        "read",
        "use",
        "update",
        "delete",
        "manage-permissions",
        "configure-deployment-spec",
      ].map((action) => ({ resource: "mcpRegistry", scope: "*", action })),
    } as ReturnType<typeof useScopedCapabilities>);
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
    reauthenticateMutateAsync.mockResolvedValue({ id: "srv-1" });
    // Shared with the whole organization unless a test says otherwise.
    sharedWith("organization");
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
          canUseCredential: true,
          createdAt: "2026-08-02T10:00:00.000Z",
        },
      ],
    });
  }

  it("states the Overview facts without a click and keeps installations visible", () => {
    renderPage();

    const overview = section("Overview");
    expect(overview.getByText("Transport")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Installations" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Installations" }),
    ).not.toBeInTheDocument();
  });

  it("names the main page in the tab strip, so a secondary tab has a way back", () => {
    renderPage();

    // Selection is the caller's to state: the main page is the absence of
    // `?tab=`, so its href is a prefix of every other tab's URL.
    // PageLayout renders each tab in a desktop row and a mobile row.
    const [overviewTab] = screen.getAllByRole("link", { name: "Overview" });
    expect(overviewTab).toHaveAttribute("href", "/mcp/registry/cat-1");
    expect(overviewTab).toHaveAttribute("aria-current", "page");
    const [usageTab] = screen.getAllByRole("link", { name: /Usage/ });
    expect(usageTab).not.toHaveAttribute("aria-current");
  });

  it("keeps editor-only command and installation prompts out of Overview", () => {
    renderPage();

    expect(screen.queryByText("sh -c node server.js --port 8080")).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Environment variables" }),
    ).toBeNull();
    expect(screen.queryByText("API_TOKEN")).toBeNull();
    expect(screen.getByText("Default")).toBeVisible();
  });

  it("shows the deployment facts the wizard asks for", () => {
    renderPage();

    const overview = section("Overview");
    expect(overview.getByText(/Single-tenant/)).toBeInTheDocument();
    expect(overview.getByText("stdio")).toBeInTheDocument();
    expect(overview.queryByText("Generated")).toBeNull();
  });

  it("labels a server with no transport set as stdio, which is what it runs", () => {
    renderPage({
      localConfig: { ...localItem.localConfig, transportType: undefined },
    });

    const overview = section("Overview");
    expect(overview.getByText("stdio")).toBeInTheDocument();
    expect(overview.queryByText(/Streamable HTTP/)).toBeNull();
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

    const overview = section("Overview");
    expect(overview.getByText("OAuth 2.1")).toBeInTheDocument();
    expect(
      overview.getByText("https://tools.example.com/mcp"),
    ).toBeInTheDocument();
    // The client id, the secret's state and the endpoints are the wizard's;
    // the row says only how callers authenticate, and never a secret's value.
    expect(screen.queryByText("abc123")).toBeNull();
    expect(screen.queryByText("shhh")).toBeNull();
  });

  it("leaves record metadata and exact tool inventory to their dedicated surfaces", () => {
    renderPage({
      scope: "team",
      teams: [
        { id: "t1", name: "Platform", level: "write" },
        { id: "t2", name: "Support", level: "use" },
      ],
    });

    expect(screen.queryByRole("heading", { name: "Details" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Tools" })).toBeNull();
    expect(screen.queryByText("Platform")).toBeNull();
    expect(screen.queryByText("Support")).toBeNull();
  });

  it("keeps the header's Edit as the only way into the configuration", () => {
    renderPage();

    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      "/mcp/registry/cat-1/edit?step=configuration",
    );
    expect(section("Overview").queryByRole("link")).toBeNull();
  });

  it("allows template editing before installation without a competing configuration Edit action", () => {
    useMcpServers.mockReturnValue({ data: [] });
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("tab=yaml") as ReturnType<typeof useSearchParams>,
    );
    renderPage();
    expect(screen.getByRole("link", { name: "K8s YAML" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
  });

  it.each([
    "edit",
    "full-access",
    "other-entry",
  ])("ignores a YAML deep link for %s access", (access) => {
    vi.mocked(useScopedCapabilities).mockReturnValue({
      data: (access === "edit"
        ? ["read", "use", "update"]
        : access === "full-access"
          ? ["read", "use", "update", "delete", "manage-permissions"]
          : [
              "read",
              "use",
              "update",
              "delete",
              "manage-permissions",
              "configure-deployment-spec",
            ]
      ).map((action) => ({
        organizationId: "org",
        resource: "mcpRegistry",
        scope: access === "other-entry" ? "cat-other" : "cat-1",
        action,
      })),
    } as ReturnType<typeof useScopedCapabilities>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("tab=yaml") as ReturnType<typeof useSearchParams>,
    );
    renderPage();
    expect(screen.queryByRole("link", { name: "K8s YAML" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Overview" })).toBeVisible();
  });

  it("hides managed Playwright configuration actions and ignores YAML deep links", () => {
    useMcpServers.mockReturnValue({
      data: [
        {
          id: "managed-browser",
          catalogId: PLAYWRIGHT_MCP_CATALOG_ID,
          serverType: "local",
          ownerId: null,
          teamId: null,
          createdAt: "2026-08-02T10:00:00.000Z",
        },
      ],
    });
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("tab=yaml") as ReturnType<typeof useSearchParams>,
    );
    renderPage({ id: PLAYWRIGHT_MCP_CATALOG_ID, name: "Playwright" });

    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Configuration/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    expect(screen.queryByRole("link", { name: "K8s YAML" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Overview" })).toBeVisible();
  });

  it("keeps the issue visible with only Dismiss because remediation is elsewhere on the page", () => {
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

    const pageTitle = screen.getByRole("heading", { level: 1 });
    expect(within(pageTitle).queryByText("Needs re-authentication")).toBeNull();
    expect(
      within(pageTitle.parentElement as HTMLElement).queryByText(
        "Needs re-authentication",
      ),
    ).toBeNull();
    const issue = within(
      screen.getByTestId("mcp-registry-attention-row-internal-tools"),
    );
    expect(
      issue.getByText(/The provider rejected the stored token/),
    ).toBeVisible();
    expect(
      issue.getByRole("button", { name: "Dismiss alert for internal-tools" }),
    ).toBeVisible();
    expect(issue.queryByRole("button", { name: "Re-authenticate" })).toBeNull();
    expect(
      issue.queryByRole("button", { name: "Edit configuration" }),
    ).toBeNull();
    expect(issue.queryByRole("button", { name: /More actions/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Status" })).toBeNull();
  });

  it("keeps dismissed alerts off the server details page", () => {
    installedWithNoDeploymentEntry();
    vi.mocked(useMcpServerIssues).mockReturnValue({
      issuesByCatalog: new Map([
        [
          "cat-1",
          [
            {
              kind: "needs-reauth",
              audience: "you",
              catalogId: "cat-1",
              serverId: "srv-1",
              detail: "invalid_grant",
              since: null,
              fingerprint: "v1:needs-reauth:test",
              muted: true,
              mutedReason: null,
            },
          ],
        ],
      ]),
    } as unknown as ReturnType<typeof useMcpServerIssues>);
    renderPage({ serverType: "remote", localConfig: null });

    expect(
      screen.queryByTestId("mcp-registry-attention-row-internal-tools"),
    ).toBeNull();
  });

  it("repairs the selected connection inline without opening a dialog", async () => {
    const user = userEvent.setup();
    const replace = vi.fn();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("tab=credentials&server=srv-1") as ReturnType<
        typeof useSearchParams
      >,
    );
    vi.mocked(useFeature).mockReturnValue(
      false as ReturnType<typeof useFeature>,
    );
    useMcpServers.mockReturnValue({
      data: [
        {
          id: "srv-1",
          catalogId: "cat-1",
          name: "internal-tools",
          serverType: "local",
          ownerId: "u1",
          ownerEmail: "admin@example.com",
          teamId: null,
          scope: "org",
          canUseCredential: true,
          secretStorageType: "none",
          createdAt: "2026-08-02T10:00:00.000Z",
          assignedAgents: [],
          oauthRefreshError: "refresh_failed",
          oauthRefreshErrorMessage: "invalid_grant",
          oauthRefreshErrorDescription:
            "The refresh token has expired or been revoked.",
          oauthRefreshFailedAt: null,
        },
      ],
    });
    vi.mocked(useMcpServerIssues).mockReturnValue({
      issuesByCatalog: new Map([
        [
          "cat-1",
          [
            {
              kind: "needs-reauth",
              audience: "you",
              catalogId: "cat-1",
              serverId: "srv-1",
              detail: "The refresh token has expired or been revoked.",
              since: null,
              fingerprint: "v1:needs-reauth:test",
              muted: false,
              mutedReason: null,
            },
          ],
        ],
      ]),
    } as unknown as ReturnType<typeof useMcpServerIssues>);

    // This catalog intentionally has no oauthConfig: the server error payload,
    // not catalog metadata, is the source of truth for the required action.
    renderPage({ oauthConfig: null });

    const form = screen.getByTestId("inline-mcp-reauthentication-form");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(form).getByText("Connection owner")).toBeInTheDocument();
    expect(within(form).getByText("Organization")).toBeInTheDocument();
    expect(
      within(form).getByText(/Use Manage credentials to add or remove/),
    ).toBeInTheDocument();
    const installationRow = screen.getByRole("row", { name: /Organization/ });
    expect(
      within(installationRow).getByText("admin@example.com"),
    ).toBeVisible();
    expect(within(installationRow).queryByText(/Created by:/)).toBeNull();
    expect(
      within(installationRow).queryByText(
        "The refresh token is invalid, expired, or has been revoked",
      ),
    ).toBeNull();
    expect(
      within(installationRow).getByRole("button", { name: "Revoke" }),
    ).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/API_TOKEN/), "new-token");
    await user.click(
      within(form).getByRole("button", { name: "Update Credentials" }),
    );
    await waitFor(() =>
      expect(reauthenticateMutateAsync).toHaveBeenCalledWith({
        id: "srv-1",
        name: "internal-tools",
        environmentValues: { API_TOKEN: "new-token" },
        userConfigValues: {},
        isByosVault: false,
      }),
    );
    expect(replace).toHaveBeenCalledWith(
      "/mcp/registry/cat-1?tab=credentials",
      { scroll: false },
    );
  });

  it("confirms revoking an organization connection against the agents it affects", async () => {
    const user = userEvent.setup();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("tab=credentials") as ReturnType<
        typeof useSearchParams
      >,
    );
    const agent = { agentType: "agent", ownerId: null, ownerEmail: null };
    useMcpServers.mockReturnValue({
      data: [
        {
          id: "srv-org",
          catalogId: "cat-1",
          name: "internal-tools",
          serverType: "remote",
          ownerId: "u1",
          ownerEmail: "admin@example.com",
          teamId: null,
          scope: "org",
          secretStorageType: "none",
          createdAt: "2026-08-02T10:00:00.000Z",
          // Every caller may resolve to an org connection, so unpinned agents
          // count as affected too.
          assignedAgents: [
            {
              ...agent,
              id: "a1",
              name: "Sales Agent",
              scope: "org",
              pinned: false,
            },
            {
              ...agent,
              id: "a2",
              name: "Ops Gateway",
              scope: "org",
              pinned: true,
            },
          ],
        },
      ],
    });
    renderPage({ serverType: "remote", localConfig: null });

    const row = screen.getByRole("row", { name: /Organization/ });
    await user.click(within(row).getByRole("button", { name: "Revoke" }));

    const dialog = await screen.findByRole("dialog");
    expect(deleteMutateAsync).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent(
      "removes the organization-wide connection for everyone",
    );
    expect(dialog).toHaveTextContent("Used by 2 agents");
    await user.click(within(dialog).getByRole("button", { name: "Uninstall" }));
    expect(deleteMutateAsync).toHaveBeenCalledWith({
      id: "srv-org",
      name: "internal-tools",
    });
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

    const pageTitle = screen.getByRole("heading", { level: 1 });
    expect(within(pageTitle).queryByText("Needs re-authentication")).toBeNull();
    const issue = within(
      screen.getByTestId("mcp-registry-attention-row-internal-tools"),
    );
    expect(
      issue.getByText(/The provider rejected the stored token/),
    ).toBeInTheDocument();
    expect(issue.queryByText(/The server could not start/)).toBeNull();
  });

  it("does not claim a pod is running when no pod status has been reported", () => {
    installedWithNoDeploymentEntry();
    renderPage();

    // A green dot is a claim about a pod. With Kubernetes reachable and no
    // entry for this install, the honest answer is that the state is unknown.
    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Installed")).toBeNull();
  });

  it("shows no status beside an installed remote server, which has no pod", () => {
    installedWithNoDeploymentEntry();
    renderPage({ serverType: "remote", localConfig: null });

    expect(screen.queryByText("Installed")).toBeNull();
    expect(screen.queryByText("Status unavailable")).toBeNull();
    expect(screen.queryByText("Not installed")).toBeNull();
  });

  it("leads an installed server with tools on to the Connect page", () => {
    installedWithNoDeploymentEntry();
    renderPage({ serverType: "remote", localConfig: null, toolCount: 3 });

    expect(screen.getByRole("link", { name: "Connect" })).toHaveAttribute(
      "href",
      "/connection",
    );
  });

  it("offers no Connect before the server is installed", () => {
    useMcpServers.mockReturnValue({ data: [] });
    renderPage({ serverType: "remote", localConfig: null, toolCount: 3 });

    expect(screen.queryByRole("link", { name: "Connect" })).toBeNull();
  });

  it("says it is still checking while the deployment feed is loading", () => {
    installedWithNoDeploymentEntry();
    useMcpDeploymentStatuses.mockReturnValue({
      statuses: {},
      state: "loading",
    });
    renderPage();

    expect(screen.getByText("Checking…")).toBeInTheDocument();
  });

  it("says a built-in server is built in, rather than not installed", () => {
    renderPage({ serverType: "builtin", localConfig: null });

    expect(screen.getByText("Built-in")).toBeInTheDocument();
    expect(screen.queryByText("Not installed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Overview" })).toBeNull();
  });

  it("gives a built-in server an Overview with something in it", () => {
    renderPage({ serverType: "builtin", localConfig: null, toolCount: 12 });

    const overview = section("Overview");
    expect(overview.getByText("Built into Archestra")).toBeInTheDocument();
    expect(overview.getByText("12 available")).toBeInTheDocument();
  });
});
describe("McpCatalogItemDetailPage installations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useScopedCapabilities).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useScopedCapabilities>);
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
    vi.mocked(useMissingPermissions).mockReturnValue({});
    vi.mocked(useMcpServerIssues).mockReturnValue({
      issuesByCatalog: new Map(),
    } as unknown as ReturnType<typeof useMcpServerIssues>);
    useMcpServers.mockReturnValue({ data: [] });
    useMcpDeploymentStatuses.mockReturnValue({ statuses: {}, state: "ready" });
    viewAs("editor");
    sharedWith("organization");
  });

  it("shows a member only their own installations, without shared ones or pod details", () => {
    viewAs("member");
    installed([teamInstall(), ownInstall()]);
    renderPage();

    const content = connections();
    expect(content.queryByText("Shared installations")).toBeNull();
    expect(content.queryByText("Platform")).toBeNull();
    expect(
      content.queryByRole("button", { name: /Add shared installation/ }),
    ).toBeNull();
    expect(columnNames(content)).toEqual(["Owner", "Created At", "Action"]);
    const [row, ...otherRows] = content.getAllByRole("row").slice(1);
    expect(row).toHaveTextContent("member@example.com");
    expect(otherRows).toEqual([]);
    // One's own installation is at most one, so the heading names one, with
    // neither a count nor an explanation.
    const heading = screen.getByRole("heading", { name: /Installation/ });
    expect(heading).toHaveTextContent(/^Installation$/);
    expect(screen.queryByText(/available only to/)).toBeNull();
  });

  it("keeps a member's remote server free of shared credential choices", () => {
    viewAs("member");
    installed([
      teamInstall({ serverType: "remote" }),
      ownInstall({ serverType: "remote" }),
    ]);
    renderPage({ serverType: "remote", localConfig: null });

    const content = connections();
    expect(content.queryByText("Default credential")).toBeNull();
    expect(content.queryByText("Service accounts")).toBeNull();
    expect(
      content.queryByRole("button", { name: /Add service account/ }),
    ).toBeNull();
    expect(content.getByText("member@example.com")).toBeVisible();
  });

  it("keeps the full view for someone who manages installations", () => {
    installed([teamInstall(), ownInstall()]);
    renderPage();

    const content = connections();
    expect(content.getByText("Shared installations")).toBeVisible();
    expect(content.getByText("Platform")).toBeVisible();
    expect(columnNames(content)).toContain("Pod");
    expect(columnNames(content)).toContain("Secret Storage");
    expect(
      screen.getByRole("heading", { name: /Installations/ }),
    ).toHaveTextContent(/^Installations2$/);
  });

  it("tells a member their server's state without a ratio, and gives them no shell", () => {
    installed([ownInstall({ canUseCredential: true })]);
    const { unmount } = renderPage();
    expect(screen.getByText("1/1 running")).toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: "Shell" }).length,
    ).toBeGreaterThan(0);
    unmount();

    viewAs("member");
    renderPage();
    // One's own installation is the only one, so "1/1" could only ever read
    // 0/1 or 1/1.
    expect(screen.queryByText(/\d+\/\d+ running/)).toBeNull();
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    expect(screen.queryAllByRole("link", { name: "Shell" })).toEqual([]);
    expect(
      screen.getAllByRole("link", { name: "Logs" }).length,
    ).toBeGreaterThan(0);
  });

  it("shows the Permissions tab only to someone who can change them", () => {
    installed([ownInstall()]);
    const { unmount } = renderPage();
    expect(
      screen.getAllByRole("link", { name: "Permissions" }).length,
    ).toBeGreaterThan(0);
    unmount();

    viewAs("member");
    sharedWith("organization", { canManagePermissions: false });
    renderPage();
    expect(screen.queryAllByRole("link", { name: "Permissions" })).toEqual([]);
  });

  it("keeps Usage for someone who manages installations and drops it for a member", () => {
    installed([ownInstall()]);
    const { unmount } = renderPage();
    expect(
      screen.getAllByRole("link", { name: /Usage/ }).length,
    ).toBeGreaterThan(0);
    unmount();

    viewAs("member");
    renderPage();
    expect(screen.queryAllByRole("link", { name: /Usage/ })).toEqual([]);
  });

  it("keeps the full section for an editor on a server shared with nobody", () => {
    sharedWith("owner", { canManagePermissions: false });
    installed([ownInstall()]);
    renderPage();

    // The one-row layout, but an editor's heading, count and Permissions tab.
    const heading = screen.getByRole("heading", { name: /Installations/ });
    expect(heading).toHaveTextContent(/^Installations1$/);
    expect(
      screen.getByText(/Running instances of this server/),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: "Permissions" }).length,
    ).toBeGreaterThan(0);
  });

  it("keeps the default credential for someone who manages a remote server", () => {
    installed([teamInstall({ serverType: "remote" })]);
    renderPage({ serverType: "remote", localConfig: null });

    expect(connections().getByText("Default credential")).toBeVisible();
    expect(connections().getByText("Service accounts")).toBeVisible();
  });

  it("shows a personal server's own installation as one row and uninstalls it after confirming", async () => {
    const user = userEvent.setup();
    viewAs("member");
    sharedWith("owner");
    installed([ownInstall()]);
    renderPage();

    const content = connections();
    expect(content.queryByRole("table")).toBeNull();
    expect(content.getByText("Running")).toBeVisible();
    expect(content.getByText("Installed Aug 2, 2026")).toBeVisible();
    expect(content.queryByText("Personal installations")).toBeNull();

    await user.click(content.getByRole("button", { name: "Uninstall" }));
    const dialog = await screen.findByRole("dialog");
    expect(deleteMutateAsync).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Uninstall" }));
    expect(deleteMutateAsync).toHaveBeenCalledWith({
      id: "srv-own",
      name: "internal-tools",
    });
  });

  it("offers to install a personal server the viewer has not installed", () => {
    viewAs("member");
    sharedWith("owner");
    renderPage();

    const content = connections();
    expect(content.queryByRole("table")).toBeNull();
    expect(content.getByText("Not installed")).toBeVisible();
    expect(content.getByRole("button", { name: "Install" })).toBeVisible();
  });

  it.each([
    ["local", "Installed Aug 2, 2026"],
    ["remote", "Connected Aug 2, 2026"],
  ] as const)("states a %s personal installation once when it has no status to add", (serverType, line) => {
    viewAs("member");
    sharedWith("owner");
    useMcpServers.mockReturnValue({ data: [ownInstall({ serverType })] });
    renderPage(
      serverType === "remote" ? { serverType, localConfig: null } : {},
    );

    const row = screen.getByTestId("credential-row");
    expect(row).toHaveTextContent(new RegExp(`^${line}Uninstall$`));
  });

  it("says a personal remote server without a connection is not connected", () => {
    viewAs("member");
    sharedWith("owner");
    renderPage({ serverType: "remote", localConfig: null });

    const content = connections();
    expect(content.getByText("Not connected")).toBeVisible();
    expect(
      content.getByRole("button", { name: "Connect my account" }),
    ).toBeVisible();
  });

  it("offers re-authentication on a personal connection whose token was rejected", () => {
    viewAs("member");
    sharedWith("owner");
    installed([
      ownInstall({ serverType: "remote", oauthRefreshError: "refresh_failed" }),
    ]);
    renderPage({ serverType: "remote", localConfig: null });

    const content = connections();
    expect(content.getByText("Needs re-authentication")).toBeVisible();
    expect(
      content.getByRole("button", { name: "Re-authenticate" }),
    ).toBeVisible();
    expect(content.getByRole("button", { name: "Uninstall" })).toBeVisible();
  });

  it("keeps the tables on a personal server when someone else has installed it", () => {
    sharedWith("owner");
    installed([
      ownInstall({ id: "srv-other", ownerId: "u2", ownerEmail: "b@x.com" }),
    ]);
    renderPage();

    const content = connections();
    expect(content.getByRole("table")).toBeVisible();
    expect(content.getByText("b@x.com")).toBeVisible();
  });

  it.each([
    "team",
    "unreadable",
  ] as const)("keeps the tables when the sharing level is %s", (sharing) => {
    sharedWith(sharing);
    installed([ownInstall()]);
    renderPage();

    expect(connections().getByRole("table")).toBeVisible();
  });

  it("shows neither layout while the sharing level loads", () => {
    sharedWith("loading");
    installed([ownInstall()]);
    renderPage();

    const content = within(
      screen
        .getByRole("heading", { name: /Installations/ })
        .closest("section") as HTMLElement,
    );
    expect(content.queryByRole("table")).toBeNull();
    expect(content.queryByText("Running")).toBeNull();
  });
});

function viewAs(role: "member" | "editor") {
  vi.mocked(useHasPermissions).mockImplementation(((
    permissions: Record<string, string[]>,
  ) => ({
    // A member may install for themselves but neither manage others'
    // installations nor edit the catalog.
    data:
      role === "editor" ||
      !(
        permissions.mcpServerInstallation?.includes("update") ||
        permissions.mcpRegistry?.includes("update")
      ),
  })) as unknown as typeof useHasPermissions);
}

function sharedWith(
  audience: "owner" | "team" | "organization" | "unreadable" | "loading",
  { canManagePermissions = true }: { canManagePermissions?: boolean } = {},
) {
  if (audience === "loading") {
    useResourcePermissions.mockReturnValue({
      data: undefined,
      isPending: true,
    });
    return;
  }
  if (audience === "unreadable") {
    useResourcePermissions.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
    });
    return;
  }
  const subject =
    audience === "owner"
      ? { type: "user", id: "u1" }
      : audience === "team"
        ? { type: "team", id: "t1" }
        : { type: "organization", id: "org" };
  useResourcePermissions.mockReturnValue({
    data: {
      grants: [{ subject, actions: ["read", "use"] }],
      effectiveActions: canManagePermissions
        ? ["read", "use", "update", "delete", "manage-permissions"]
        : ["read", "use"],
    },
    isPending: false,
  });
}

function ownInstall(overrides: Record<string, unknown> = {}) {
  return {
    id: "srv-own",
    catalogId: "cat-1",
    name: "internal-tools",
    serverType: "local",
    ownerId: "u1",
    ownerEmail: "member@example.com",
    teamId: null,
    scope: "personal",
    secretStorageType: "database",
    createdAt: "2026-08-02T10:00:00.000Z",
    assignedAgents: [],
    ...overrides,
  };
}

function teamInstall(overrides: Record<string, unknown> = {}) {
  return ownInstall({
    id: "srv-team",
    ownerId: "u9",
    ownerEmail: "admin@example.com",
    teamId: "t1",
    teamDetails: { teamId: "t1", name: "Platform" },
    scope: "team",
    ...overrides,
  });
}

function installed(servers: Record<string, unknown>[]) {
  useMcpServers.mockReturnValue({ data: servers });
  useMcpDeploymentStatuses.mockReturnValue({
    statuses: Object.fromEntries(
      servers.map((server) => [
        server.id,
        {
          state: "running",
          message: "",
          error: null,
          podName: `pod-${server.id}`,
        },
      ]),
    ),
    state: "ready",
  });
}

function connections() {
  return within(screen.getByTestId("mcp-server-settings-connections-content"));
}

function columnNames(content: ReturnType<typeof within>) {
  return content
    .getAllByRole("columnheader")
    .map((header: HTMLElement) => header.textContent);
}
