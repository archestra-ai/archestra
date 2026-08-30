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
      "useDismissMcpServerAlerts",
      "useRestoreMcpServerAlerts",
    ],
    {
      useMcpServers: () => useMcpServers(),
      useAutoModeAgents: () => ({ data: [] }),
      useMcpDeploymentStatuses: () => useMcpDeploymentStatuses(),
      useMcpInstallationStatusCacheSync: () => {},
      useReauthenticateMcpServer: () => ({
        mutateAsync: reauthenticateMutateAsync,
        isPending: false,
      }),
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
  const result = render(
    <QueryClientProvider client={new QueryClient()}>
      <McpCatalogItemPage id="cat-1" />
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

  it("keeps one Edit in the header, and points Overview at the same place", () => {
    renderPage();

    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      "/mcp/registry/cat-1/edit?step=configuration",
    );
    expect(
      section("Overview").getByRole("link", { name: /Configuration/ }),
    ).toHaveAttribute("href", "/mcp/registry/cat-1/edit?step=configuration");
    expect(
      section("Overview").queryByRole("link", { name: /^Edit\b/ }),
    ).toBeNull();
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
    expect(issue.getByText("Needs re-authentication")).toBeVisible();
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
    expect(screen.getByText("Installed")).toBeInTheDocument();
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
    vi.mocked(useFeature).mockImplementation(
      (feature) =>
        (feature === "mcpServerAlertingEnabled") as ReturnType<
          typeof useFeature
        >,
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
    expect(issue.getByText("Needs re-authentication")).toBeInTheDocument();
    expect(issue.queryByText("Failed to start")).toBeNull();
  });

  it("does not claim a pod is running when no pod status has been reported", () => {
    installedWithNoDeploymentEntry();
    renderPage();

    // A green dot is a claim about a pod. With Kubernetes reachable and no
    // entry for this install, the honest answer is that the state is unknown.
    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Installed")).toBeNull();
  });

  it("says a remote server is installed, since it has no pod to be running", () => {
    installedWithNoDeploymentEntry();
    renderPage({ serverType: "remote", localConfig: null });

    expect(screen.getByText("Installed")).toBeInTheDocument();
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
});
