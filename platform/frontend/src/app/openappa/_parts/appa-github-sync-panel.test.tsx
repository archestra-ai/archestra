import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { toast } from "sonner";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  AppaGithubSyncPanel,
  OpenAppaSourceForm,
} from "./appa-github-sync-panel";

vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");
const navigation = vi.hoisted(() => ({
  search: new URLSearchParams(),
  replace: (() => {}) as (href: string, options?: object) => void,
}));
vi.mock("next/navigation", () => {
  const router = {
    replace: (href: string, options?: object) =>
      navigation.replace(href, options),
  };
  return {
    usePathname: () => "/settings/guardrails",
    useRouter: () => router,
    useSearchParams: () => navigation.search,
  };
});
const url = "http://localhost:9000/api/openappa/github-sync";
const server = setupServer();
let state: archestraApiTypes.GetAppaGithubSyncResponses["200"];
const source = {
  organizationId: "org",
  repo: "example/policies",
  ref: "main",
  path: "appa.toml",
  interval: "1h" as const,
  githubPatId: null,
  gitlabTokenId: null,
  githubAppConfigId: null,
  revision: "revision",
  sourceCommit: "a".repeat(40),
  setupPullRequestNumber: null,
  lastSyncedAt: "2026-09-15T12:00:00Z",
  lastSyncError: null,
  declarationsPendingPublish: false,
  heldContentHash: null,
  heldSourceCommit: null,
  heldReasons: [],
};
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  navigation.search = new URLSearchParams();
  // Replacing the URL drops its query, as the router would.
  navigation.replace = vi.fn(() => {
    navigation.search = new URLSearchParams();
  });
  state = {
    validationDirectory: "traces",
    enabled: true,
    hasPolicy: true,
    githubWebUrl: "https://github.com",
    provider: "github",
    source,
  };
  server.use(http.get(url, () => HttpResponse.json(state)));
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
/** The held pull itemized, and the reads its review dialog names things with. */
function serveHeld(credentials: Array<{ key: string; name: string }> = []) {
  server.use(
    http.get(`${url}/held`, () =>
      HttpResponse.json({
        sourceCommit: "c".repeat(40),
        reasons: ["changes_credentials"],
        grants: [
          {
            battery: "github",
            variable: "APPA_PROVIDER_GITHUB_TOKEN",
            key: "github-token",
          },
        ],
        droppedBatteries: [],
      }),
    ),
    http.get("http://localhost:9000/api/openappa/batteries", () =>
      HttpResponse.json([]),
    ),
    http.get("http://localhost:9000/api/internal_mcp_catalog", () =>
      HttpResponse.json([]),
    ),
    http.get("http://localhost:9000/api/credentials", () =>
      HttpResponse.json(credentials),
    ),
  );
}

function show(content = <AppaGithubSyncPanel />) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{content}</QueryClientProvider>);
  return client;
}

test("syncs on demand and shows the server's failure while retaining the source", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  server.use(
    http.patch(url, async ({ request }) => {
      await pending;
      expect(await request.json()).toEqual({ action: "sync" });
      state = {
        ...state,
        source: { ...source, lastSyncError: "GitHub returned HTTP 403" },
      };
      return HttpResponse.json(state);
    }),
  );
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
  expect(
    await screen.findByRole("button", { name: "Syncing…" }),
  ).toBeDisabled();
  finish();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "GitHub returned HTTP 403",
  );
  expect(screen.getByRole("link", { name: /example\/policies/ })).toBeVisible();
  expect(toast.success).not.toHaveBeenCalled();
});

test("a held pull waits for approval, not a failure, and is approved from its review", async () => {
  const message =
    "The repository's policy gives the github battery the github-token credential.";
  state = {
    ...state,
    source: {
      ...source,
      heldReasons: ["changes_credentials"],
      lastSyncError: message,
    },
  };
  let accepted = false;
  server.use(
    http.post(`${url}/accept-held`, () => {
      accepted = true;
      state = {
        ...state,
        source: { ...source, heldReasons: [], lastSyncError: null },
      };
      return HttpResponse.json({
        contentHash: "a".repeat(64),
        sourceCommit: "b".repeat(40),
        reasons: ["changes_credentials"],
        droppedBatteries: [],
        changedVariables: ["APPA_PROVIDER_GITHUB_TOKEN"],
      });
    }),
  );
  show();
  expect(await screen.findByText("Needs approval")).toBeVisible();
  expect(screen.queryByText("Sync failed")).not.toBeInTheDocument();
  expect(screen.getByText("A change from GitHub needs approval")).toBeVisible();
  expect(screen.getByText(new RegExp(message))).toBeVisible();
  expect(screen.getByRole("link", { name: "See batteries" })).toHaveAttribute(
    "href",
    "/openappa/batteries",
  );
  serveHeld();
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  const dialog = await screen.findByRole("dialog");
  // Each grant reads as the battery, the credential it gets and the variable it fills.
  expect(await within(dialog).findByText("github")).toBeVisible();
  expect(within(dialog).getByText("github-token")).toBeVisible();
  expect(within(dialog).getByText("APPA_PROVIDER_GITHUB_TOKEN")).toBeVisible();
  // No credential holds that key yet, and the dialog says so.
  expect(await within(dialog).findByLabelText("Not saved yet")).toBeVisible();
  // Declining happens in the repository; the dialog points there.
  expect(
    within(dialog).getByRole("link", { name: /Edit appa\.toml in GitHub/ }),
  ).toHaveAttribute(
    "href",
    "https://github.com/example/policies/blob/main/appa.toml",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(accepted).toBe(true));
  expect(await screen.findByText("Connected")).toBeVisible();
});

test("only someone who may bind credentials can approve a credential change", async () => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({ data: !permissions.credential }) as ReturnType<
        typeof useHasPermissions
      >,
  );
  state = {
    ...state,
    source: {
      ...source,
      heldReasons: ["changes_credentials"],
      lastSyncError:
        "The repository's policy gives the github battery the github-token credential.",
    },
  };
  serveHeld();
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Review" }));
  const dialog = await screen.findByRole("dialog");
  // Without access to the credentials list, the key itself names it.
  expect(await within(dialog).findByText("github-token")).toBeVisible();
  expect(
    within(dialog).getByRole("button", { name: "Approve" }),
  ).toBeDisabled();
  expect(
    within(dialog).getByText(
      "Approving takes permission to update guardrails, and Can use on every credential.",
    ),
  ).toBeVisible();
});

test("confirms disconnect, stops automatic updates and preserves the accepted policy", async () => {
  server.use(
    http.patch(url, async ({ request }) => {
      expect(await request.json()).toEqual({ action: "disconnect" });
      state = { ...state, source: { ...source, interval: null } };
      return HttpResponse.json(state);
    }),
  );
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Stop syncing" }));
  expect(await screen.findByText("Stop APPA policy sync?")).toBeVisible();
  const buttons = screen.getAllByRole("button", { name: "Stop syncing" });
  fireEvent.click(buttons[buttons.length - 1]);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Sync now" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    await screen.findByRole("button", { name: "Reconnect GitHub" }),
  ).toBeVisible();
  expect(
    screen.getByText(/Your last synced policy stays active/),
  ).toBeVisible();
});

test("read-only users see status without mutation controls", async () => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data:
          permissions.organizationSettings?.every(
            (action) => action === "read",
          ) ?? false,
      }) as ReturnType<typeof useHasPermissions>,
  );
  show();
  expect(await screen.findByText("Connected")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Sync now" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Edit source" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Stop syncing" }),
  ).not.toBeInTheDocument();
});

test("a load failure stays an error until the user retries", async () => {
  server.use(http.get(url, () => new HttpResponse(null, { status: 503 })));
  show();
  expect(await screen.findByText("Could not load APPA sync")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Connect GitHub" }),
  ).not.toBeInTheDocument();
  server.use(http.get(url, () => HttpResponse.json(state)));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Connected")).toBeVisible();
});

const appId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const githubApp = "http://localhost:9000/api/openappa/github-app";
/** The organization's GitHub Apps, as saved credentials. */
function serveApps(apps: [string, string][]) {
  server.use(
    http.get("http://localhost:9000/api/credentials", () =>
      HttpResponse.json(
        apps.map(([id, name]) => ({
          id,
          name,
          kind: "github_app",
          allowOrganization: true,
          organizationConfigured: true,
        })),
      ),
    ),
    http.get(`${githubApp}/pending`, () => HttpResponse.json(null)),
    http.get(`${githubApp}/accounts`, () =>
      HttpResponse.json(apps.map(([id]) => ({ id, account: "example" }))),
    ),
  );
}
/** What each App can reach; only the chosen App's list is asked for. */
function serveRepositories(byApp: Record<string, string[]>) {
  server.use(
    http.get(`${githubApp}/repositories`, ({ request }) => {
      const id = new URL(request.url).searchParams.get("credentialId") ?? "";
      return HttpResponse.json({
        repositories: (byApp[id] ?? []).map((fullName) => ({
          fullName,
          private: true,
          description: null,
          template: fullName.endsWith("/openappa-policy"),
        })),
        manageUrl:
          "https://github.com/organizations/example/settings/installations/1",
      });
    }),
  );
}

test("links an existing repository whose policy lives elsewhere through Advanced", async () => {
  state = { ...state, hasPolicy: false, source: null };
  serveApps([[appId, "Policy App"]]);
  serveRepositories({ [appId]: ["example/other", "example/policies"] });
  server.use(
    http.get(`${githubApp}/repository`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      expect(query.get("credentialId")).toBe(appId);
      return HttpResponse.json({
        status:
          query.get("repo") === "example/policies" &&
          query.get("ref") === "prod" &&
          query.get("path") === "policy/appa.toml"
            ? "policy"
            : "other",
        validations: true,
      });
    }),
    http.post(`${url}/repository`, async ({ request }) => {
      expect(await request.json()).toEqual({
        owner: "example",
        name: "policies",
        githubAppConfigId: appId,
        interval: "1h",
        existing: true,
        replace: false,
        ref: "prod",
        path: "policy/appa.toml",
      });
      state = {
        ...state,
        source: {
          ...source,
          ref: "prod",
          path: "policy/appa.toml",
          githubAppConfigId: appId,
          sourceCommit: null,
          lastSyncedAt: null,
        },
      };
      return HttpResponse.json(state);
    }),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Set up Git sync" }),
  );
  fireEvent.click(screen.getByRole("button", { name: /^GitHub/ }));
  fireEvent.change(screen.getByLabelText("Organization"), {
    target: { value: "example" },
  });
  fireEvent.click(screen.getByText("Use an existing repository"));
  // With a single App there is nothing to pick: it goes straight to its repositories.
  fireEvent.click(await screen.findByText("Use an App I already have"));
  fireEvent.click(await screen.findByRole("combobox", { name: "Repository" }));
  fireEvent.click(screen.getByRole("option", { name: /example\/policies/ }));
  expect(
    await screen.findByText(/No appa.toml/, {}, { timeout: 3000 }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Connect repository" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
  fireEvent.change(screen.getByLabelText("Branch"), {
    target: { value: "prod" },
  });
  fireEvent.change(screen.getByLabelText("Policy file"), {
    target: { value: "policy/appa.toml" },
  });
  expect(
    await screen.findByText(/Found policy\/appa.toml/, {}, { timeout: 3000 }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));
  expect(await screen.findByText("Waiting for the first sync")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("starts fresh from the template, connects it through a chosen App and finishes once the setup PR merges", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  state = { ...state, source: null };
  serveApps([
    [appId, "Policy App"],
    [otherId, "Other App"],
  ]);
  serveRepositories({ [appId]: ["example/openappa-policy"] });
  server.use(
    http.get(`${githubApp}/repository`, () =>
      HttpResponse.json({ status: "template", validations: null }),
    ),
    http.post(`${url}/repository`, async ({ request }) => {
      expect(await request.json()).toEqual({
        owner: "example",
        name: "openappa-policy",
        githubAppConfigId: appId,
        interval: "1h",
        existing: true,
        replace: false,
      });
      state = {
        ...state,
        source: {
          ...source,
          repo: "example/openappa-policy",
          githubAppConfigId: appId,
          sourceCommit: null,
          setupPullRequestNumber: 7,
        },
      };
      return HttpResponse.json(state);
    }),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Set up Git sync" }),
  );
  fireEvent.click(screen.getByRole("button", { name: /^GitHub/ }));
  fireEvent.change(screen.getByLabelText("Organization"), {
    target: { value: "example" },
  });
  fireEvent.click(screen.getByText("Start fresh"));
  fireEvent.click(screen.getByRole("button", { name: /Create on GitHub/ }));
  const created = new URL(String(open.mock.calls[0][0]));
  expect(created.origin + created.pathname).toBe("https://github.com/new");
  expect(Object.fromEntries(created.searchParams)).toEqual({
    template_owner: "archestra-ai",
    template_name: "openappa-config",
    owner: "example",
    name: "openappa-policy",
    visibility: "private",
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(await screen.findByText("Use an App I already have"));
  fireEvent.click(await screen.findByRole("radio", { name: /Policy App/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  // The new template copy is picked without a search.
  expect(
    await screen.findByText("OpenAPPA template", {}, { timeout: 3000 }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));
  // Repository rules require a pull request: the dialog waits on it.
  expect(await screen.findByText("Finish Git sync")).toBeVisible();
  expect(screen.getByText("Merge the setup PR")).toBeVisible();
  expect(
    within(screen.getByRole("dialog")).getByRole("link", {
      name: "Review and merge",
    }),
  ).toHaveAttribute(
    "href",
    "https://github.com/example/openappa-policy/pull/7",
  );
  // Not merged yet: the check stays quiet, since the dialog already says so.
  let checks = 0;
  server.use(
    http.patch(url, () => {
      checks += 1;
      return HttpResponse.json(state);
    }),
  );
  fireEvent.focus(window);
  await waitFor(() => expect(checks).toBe(1));
  await waitFor(() =>
    expect(screen.queryByText("Checking…")).not.toBeInTheDocument(),
  );
  expect(toast.info).not.toHaveBeenCalled();
  expect(screen.getByText("Finish Git sync")).toBeVisible();
  server.use(
    http.patch(url, async ({ request }) => {
      expect(await request.json()).toEqual({ action: "sync" });
      state = {
        ...state,
        source: {
          ...source,
          repo: "example/openappa-policy",
          githubAppConfigId: appId,
          sourceCommit: "b".repeat(40),
          setupPullRequestNumber: null,
        },
      };
      return HttpResponse.json(state);
    }),
  );
  // Coming back from merging on GitHub checks at once.
  fireEvent.focus(window);
  expect(await screen.findByText("Setup finished")).toBeVisible();
  expect(screen.getByText("Merged")).toBeVisible();
  expect(toast.success).toHaveBeenCalledWith(
    "Initial policy merged. Policy synced from GitHub.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(screen.queryByText("Setup finished")).not.toBeInTheDocument(),
  );
});

test("editing an App-backed source keeps its repository and only warns about missing validations", async () => {
  state = {
    ...state,
    source: { ...source, githubAppConfigId: appId },
  };
  serveApps([[appId, "Policy App"]]);
  serveRepositories({ [appId]: ["example/policies"] });
  let saved: unknown;
  server.use(
    http.get(`${githubApp}/repository`, () =>
      HttpResponse.json({ status: "policy", validations: false }),
    ),
    http.put(url, async ({ request }) => {
      saved = await request.json();
      return HttpResponse.json(state);
    }),
  );
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Edit source" }));
  expect(await screen.findByText("Edit Git sync")).toBeVisible();
  expect(
    await screen.findByText("No traces/ folder", {}, { timeout: 3000 }),
  ).toBeVisible();
  // The repository already syncing is kept, not announced as a new find.
  expect(
    within(screen.getByRole("dialog")).queryByText(/appa\.toml/),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Branch")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(saved).toEqual({
    repo: "example/policies",
    ref: "main",
    path: "appa.toml",
    interval: "1h",
    validationDirectory: "traces",
    githubPatId: null,
    gitlabTokenId: null,
    githubAppConfigId: appId,
  });
});

test("creates a private GitLab project in a group with the saved token", async () => {
  const tokenId = "33333333-3333-4333-8333-333333333333";
  let created: unknown = null;
  state = { ...state, hasPolicy: false, source: null };
  serveApps([]);
  server.use(
    http.get("http://localhost:9000/api/git-credentials", () =>
      HttpResponse.json([
        {
          id: tokenId,
          name: "Policy token",
          provider: "gitlab",
          kind: "gitlab_token",
          webUrl: "https://gitlab.example.com",
          createdAt: "2026-10-01T00:00:00Z",
        },
      ]),
    ),
    http.get(
      `http://localhost:9000/api/git-credentials/${tokenId}/namespaces`,
      () => HttpResponse.json(["", "platform", "platform/agents"]),
    ),
    http.post(`${url}/repository`, async ({ request }) => {
      created = await request.json();
      state = {
        ...state,
        provider: "gitlab",
        githubWebUrl: "https://gitlab.example.com",
        source: {
          ...source,
          repo: "platform/openappa-policy",
          gitlabTokenId: tokenId,
          sourceCommit: null,
          lastSyncedAt: null,
        },
      };
      return HttpResponse.json(state);
    }),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Set up Git sync" }),
  );
  fireEvent.click(screen.getByRole("button", { name: /^GitLab/ }));
  expect(
    await screen.findByRole("radio", { name: /Policy token/ }),
  ).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  // The first group the token reaches is picked; the project gets a default name.
  await waitFor(() =>
    expect(screen.getByLabelText("Group")).toHaveTextContent("platform"),
  );
  expect(screen.getByLabelText("Project name")).toHaveValue("openappa-policy");
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));

  await waitFor(() =>
    expect(created).toEqual({
      owner: "platform",
      name: "openappa-policy",
      gitlabTokenId: tokenId,
      interval: "1h",
      existing: false,
    }),
  );
  expect(await screen.findByText("Git sync")).toBeVisible();
});

test("moving a GitHub sync to a new GitLab project starts GitLab fresh and replaces the running sync", async () => {
  const tokenId = "33333333-3333-4333-8333-333333333333";
  let created: unknown = null;
  state = { ...state, source: { ...source, githubAppConfigId: appId } };
  serveApps([[appId, "Policy App"]]);
  serveRepositories({ [appId]: ["example/policies"] });
  server.use(
    http.get(`${githubApp}/repository`, () =>
      HttpResponse.json({ status: "policy", validations: true }),
    ),
    http.get("http://localhost:9000/api/git-credentials", () =>
      HttpResponse.json([
        {
          id: tokenId,
          name: "Policy token",
          provider: "gitlab",
          kind: "gitlab_token",
          webUrl: "https://gitlab.example.com",
          createdAt: "2026-10-01T00:00:00Z",
        },
      ]),
    ),
    http.get(
      `http://localhost:9000/api/git-credentials/${tokenId}/namespaces`,
      () => HttpResponse.json(["", "platform"]),
    ),
    http.post(`${url}/repository`, async ({ request }) => {
      created = await request.json();
      return HttpResponse.json(state);
    }),
  );
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Edit source" }));
  expect(await screen.findByText("Edit Git sync")).toBeVisible();
  // Back to the host step, then over to GitLab.
  while (!screen.queryByRole("button", { name: /^GitLab/ }))
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: /^GitLab/ }));
  expect(
    await screen.findByRole("radio", { name: /Policy token/ }),
  ).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  // The GitHub repository means nothing on GitLab: a new project is offered instead.
  await waitFor(() =>
    expect(screen.getByLabelText("Group")).toHaveTextContent("platform"),
  );
  expect(
    within(screen.getByRole("dialog")).queryByText("example/policies"),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(created).toMatchObject({
      owner: "platform",
      name: "openappa-policy",
      gitlabTokenId: tokenId,
      existing: false,
      replace: true,
    }),
  );
});

test("moving a GitHub sync to an existing GitLab project connects that project", async () => {
  const tokenId = "33333333-3333-4333-8333-333333333333";
  let created: unknown = null;
  state = { ...state, source: { ...source, githubAppConfigId: appId } };
  serveApps([[appId, "Policy App"]]);
  serveRepositories({
    [appId]: ["example/policies"],
    [tokenId]: ["platform/policies"],
  });
  server.use(
    http.get(`${githubApp}/repository`, () =>
      HttpResponse.json({ status: "policy", validations: true }),
    ),
    http.get("http://localhost:9000/api/git-credentials", () =>
      HttpResponse.json([
        {
          id: tokenId,
          name: "Policy token",
          provider: "gitlab",
          kind: "gitlab_token",
          webUrl: "https://gitlab.example.com",
          createdAt: "2026-10-01T00:00:00Z",
        },
      ]),
    ),
    http.get(
      `http://localhost:9000/api/git-credentials/${tokenId}/namespaces`,
      () => HttpResponse.json(["", "platform"]),
    ),
    http.post(`${url}/repository`, async ({ request }) => {
      created = await request.json();
      return HttpResponse.json(state);
    }),
  );
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Edit source" }));
  while (!screen.queryByRole("button", { name: /^GitLab/ }))
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: /^GitLab/ }));
  expect(
    await screen.findByRole("radio", { name: /Policy token/ }),
  ).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(
    await screen.findByRole("radio", { name: "Existing project" }),
  );
  fireEvent.click(await screen.findByRole("combobox", { name: "Project" }));
  fireEvent.click(screen.getByRole("option", { name: /platform\/policies/ }));
  expect(
    await screen.findByText("Found appa.toml", {}, { timeout: 3000 }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(created).toMatchObject({
      owner: "platform",
      name: "policies",
      gitlabTokenId: tokenId,
      existing: true,
      replace: true,
    }),
  );
});

test("a link with ?setup=github-sync opens setup once and drops the parameter", async () => {
  navigation.search = new URLSearchParams("setup=github-sync");
  state = { ...state, source: null };
  serveApps([]);
  show();
  expect(
    await screen.findByRole("heading", { name: "Set up Git sync" }),
  ).toBeVisible();
  expect(navigation.replace).toHaveBeenCalledWith("/settings/guardrails", {
    scroll: false,
  });
});

test.each([
  ["sync already has a repository", () => {}],
  [
    "the user cannot manage sync",
    () => {
      state = { ...state, source: null };
      vi.mocked(useHasPermissions).mockImplementation(
        (permissions) =>
          ({
            data:
              permissions.organizationSettings?.every(
                (action) => action === "read",
              ) ?? false,
          }) as ReturnType<typeof useHasPermissions>,
      );
    },
  ],
])("?setup=github-sync is dropped without opening setup when %s", async (_name, arrange) => {
  navigation.search = new URLSearchParams("setup=github-sync");
  arrange();
  show();
  await waitFor(() =>
    expect(navigation.replace).toHaveBeenCalledWith("/settings/guardrails", {
      scroll: false,
    }),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("asks before discarding a GitHub source draft", async () => {
  state = { ...state, hasPolicy: false, source: null };
  server.use(
    http.get("http://localhost:9000/api/credentials", () =>
      HttpResponse.json([]),
    ),
  );
  const close = vi.fn();
  show(<OpenAppaSourceForm source={null} onOpenChange={close} />);
  fireEvent.change(screen.getByLabelText("Repository"), {
    target: { value: "example/policies" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await screen.findByText("Discard unsaved changes?")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByLabelText("Repository")).toHaveValue("example/policies");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  expect(close).toHaveBeenCalledWith(false);
});

test("leaves the validation folder and sync interval alone, and stays open on server rejection", async () => {
  server.use(
    http.get("http://localhost:9000/api/credentials", () =>
      HttpResponse.json([]),
    ),
  );
  let saved: Record<string, unknown> | undefined;
  let reject = true;
  server.use(
    http.put(url, async ({ request }) => {
      saved = (await request.json()) as Record<string, unknown>;
      if (reject)
        return HttpResponse.json(
          { error: { message: "appa.toml not found", type: "api_error" } },
          { status: 404 },
        );
      return HttpResponse.json(state);
    }),
  );
  const close = vi.fn();
  show(
    <OpenAppaSourceForm
      source={{ ...source, interval: "1d" }}
      onOpenChange={close}
    />,
  );
  expect(
    screen.queryByLabelText("Validation directory (optional)"),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Sync frequency")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save source and sync" }));
  expect(await screen.findByText("appa.toml not found")).toBeVisible();
  expect(close).not.toHaveBeenCalled();
  expect(saved).not.toHaveProperty("validationDirectory");
  expect(saved?.interval).toBe("1d");
  reject = false;
  fireEvent.click(screen.getByRole("button", { name: "Save source and sync" }));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
});

test("keeps the merge link after reload and removes it once initial sync completes", async () => {
  state = {
    ...state,
    source: { ...source, setupPullRequestNumber: 7, sourceCommit: null },
  };
  server.use(
    http.patch(url, () => {
      state = { ...state, source };
      return HttpResponse.json(state);
    }),
  );
  show();
  expect(
    await screen.findByRole("link", { name: "Review and merge PR" }),
  ).toHaveAttribute("href", "https://github.com/example/policies/pull/7");
  fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("link", { name: "Review and merge PR" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByText("Connected")).toBeVisible();
});
