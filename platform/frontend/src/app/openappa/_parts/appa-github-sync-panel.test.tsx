import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
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
vi.mock("@/lib/hooks/use-app-name", () => ({ useAppName: () => "Acme AI" }));
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
  selfService: true,
  selfServiceDirectory: "mcp",
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
    selfService: { enabled: true, setting: true, directory: "mcp" },
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

test("shows a branch rule that needs a change, with the ruleset linked and the fix, and offers to finish the setup", async () => {
  server.use(
    http.get(`${url}/protection`, () =>
      HttpResponse.json({
        checkName: "Guardrails Policy Admission",
        include: { folder: "mcp", state: "included" },
        branchRules: {
          state: "incomplete",
          url: "https://github.com/example/policies/rules/5",
          settingsUrl: "https://github.com/example/policies/settings/rules",
          detail:
            "The rule takes the Guardrails Policy Admission check from any source, so a passing one could be posted with any token. Edit it to take the check from the GitHub App only.",
        },
      }),
    ),
  );
  show();
  // One sentence, with the ruleset linked and what to change in it.
  expect(
    await screen.findByText(
      (_, element) =>
        element?.tagName === "P" &&
        /Self-service branch protection ruleset needs a change: The rule takes the Guardrails Policy Admission check from any source/.test(
          element.textContent ?? "",
        ),
    ),
  ).toBeVisible();
  expect(screen.getByRole("link", { name: "ruleset" })).toHaveAttribute(
    "href",
    "https://github.com/example/policies/rules/5",
  );
  expect(screen.getByRole("button", { name: "Finish setup" })).toBeEnabled();
});

test("Finish setup lists the permissions an existing GitHub App lacks, with where to grant and accept them", async () => {
  state = { ...state, source: { ...source, githubAppConfigId: "app-1" } };
  let granted = false;
  server.use(
    http.get(`${url}/protection`, () =>
      HttpResponse.json({
        checkName: "Guardrails Policy Admission",
        include: { folder: "mcp", state: "included" },
        branchRules: { state: "needs_permission" },
      }),
    ),
    http.get(`${url}/app-grants`, () =>
      HttpResponse.json({
        name: "Policy App",
        url: "https://github.com/apps/policy-app",
        settingsUrl: "https://github.com/settings/apps/policy-app/permissions",
        installationUrl: "https://github.com/settings/installations/7",
        permissions: [
          { name: "contents", granted: true },
          { name: "pull_requests", granted: true },
          { name: "checks", granted },
        ],
      }),
    ),
  );
  show();
  expect(
    await screen.findByText(
      (_, element) =>
        element?.tagName === "P" &&
        /waits for the GitHub App's Checks permission/.test(
          element.textContent ?? "",
        ),
    ),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
  const dialog = await screen.findByRole("dialog", {
    name: "MCP Guardrails Self-Service",
  });
  expect(
    await within(dialog).findByText(
      (_, element) =>
        element?.tagName === "SPAN" &&
        /^Missing: Checks\./.test(element.textContent ?? ""),
    ),
  ).toBeVisible();
  expect(
    within(dialog).getByRole("button", { name: /Update App/ }),
  ).toBeEnabled();
  expect(
    within(dialog).getByRole("button", { name: "Approve the request" }),
  ).toBeEnabled();
  expect(
    within(dialog).getByRole("button", { name: "Continue" }),
  ).toBeDisabled();
  granted = true;
  fireEvent.click(within(dialog).getByRole("button", { name: "Check again" }));
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Continue" }),
    ).toBeEnabled(),
  );
  expect(
    within(dialog).getByText(/every permission self-service needs/),
  ).toBeVisible();
});

test("Enable walks through the App's permission, the folder, the include pull request and the ruleset the administrator imports; the card then says what is in place", async () => {
  state = {
    ...state,
    source: { ...source, githubAppConfigId: "app-1", selfService: false },
    selfService: { enabled: false, setting: false, directory: "mcp" },
  };
  let include: Record<string, unknown> = { folder: "mcp", state: "missing" };
  const ruleset = {
    name: "Guardrails Policy Admission",
    target: "branch",
    source_type: "Repository",
    source: "example/policies",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    bypass_actors: [],
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [
            { context: "Guardrails Policy Admission", integration_id: 123 },
          ],
        },
      },
    ],
  };
  let branchRules: Record<string, unknown> = {
    state: "missing",
    settingsUrl: "https://github.com/example/policies/settings/rules",
    ruleset,
  };
  const protection = vi.fn(() =>
    HttpResponse.json({
      checkName: "Guardrails Policy Admission",
      include,
      branchRules,
    }),
  );
  const opened = vi.spyOn(window, "open").mockImplementation(() => null);
  const files: Blob[] = [];
  let downloaded: string | null = null;
  URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
    files.push(blob as Blob);
    return "blob:ruleset";
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloaded = this.download;
  });
  const actions: unknown[] = [];
  server.use(
    http.get(`${url}/app-grants`, () =>
      HttpResponse.json({
        name: "Policy App",
        url: "https://github.com/apps/policy-app",
        settingsUrl: "https://github.com/settings/apps/policy-app/permissions",
        installationUrl: "https://github.com/settings/installations/7",
        permissions: [
          { name: "contents", granted: true },
          { name: "pull_requests", granted: true },
          { name: "checks", granted: true },
        ],
      }),
    ),
    http.get(`${url}/protection`, protection),
    http.patch(url, async ({ request }) => {
      const body = (await request.json()) as {
        action: string;
        enabled?: boolean;
      };
      actions.push(body);
      if (body.action === "include_servers") {
        include = {
          folder: "rules/servers",
          state: "pull_open",
          pull: {
            number: 12,
            url: "https://github.com/example/policies/pull/12",
          },
        };
        return HttpResponse.json(state);
      }
      const on = body.enabled === true;
      state = {
        ...state,
        source: {
          ...source,
          githubAppConfigId: "app-1",
          selfService: on,
          selfServiceDirectory: on ? "rules/servers" : "mcp",
        },
        selfService: {
          enabled: on,
          setting: on,
          directory: on ? "rules/servers" : "mcp",
        },
      };
      return HttpResponse.json(state);
    }),
  );
  show();
  const enable = await screen.findByRole("button", { name: "Enable" });
  expect(enable).toBeEnabled();
  // Off: no protection to show, and nothing is read for it.
  expect(screen.queryByText(/Self-service branch protection/)).toBeNull();
  expect(protection).not.toHaveBeenCalled();

  fireEvent.click(enable);
  const dialog = await screen.findByRole("dialog", {
    name: "MCP Guardrails Self-Service",
  });
  expect(
    await within(dialog).findByText(/every permission self-service needs/),
  ).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));

  // The folder, mcp unless changed.
  const folder = await within(dialog).findByLabelText("Self-service folder");
  expect(folder).toHaveValue("mcp");
  fireEvent.change(folder, { target: { value: "rules/servers" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));

  // The switch, the pull request, then the ruleset, each reported.
  expect(
    await within(dialog).findByText("MCP Guardrails Self-Service is on"),
  ).toBeVisible();
  expect(
    (await within(dialog).findByRole("link", { name: "Pull request #12" }))
      .parentElement,
  ).toHaveTextContent(
    "Pull request #12 opened. Merge it and re-sync to apply the new settings.",
  );
  expect(actions).toEqual([
    { action: "self_service", enabled: true, directory: "rules/servers" },
    { action: "include_servers" },
  ]);
  // The ruleset is the administrator's to import: the file, the page, and
  // a way to check once it is in.
  expect(
    await within(dialog).findByText(/Import the branch ruleset on GitHub/),
  ).toHaveTextContent(
    "so a pull request merges only once the Guardrails Policy Admission check passes",
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Download ruleset" }),
  );
  expect(downloaded).toBe("guardrails-policy-admission.ruleset.json");
  expect(JSON.parse(await (files[0] as Blob).text())).toEqual(ruleset);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Open rulesets" }),
  );
  expect(opened).toHaveBeenCalledWith(
    "https://github.com/example/policies/settings/rules",
    "archestra-github-app",
  );
  branchRules = {
    state: "active",
    url: "https://github.com/example/policies/rules/5",
  };
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "Check the branch rules again",
    }),
  );
  expect(
    await within(dialog).findByText(
      /requires the Guardrails Policy Admission check on the branch/,
    ),
  ).toBeVisible();
  expect(within(dialog).getByRole("link", { name: "Ruleset" })).toHaveAttribute(
    "href",
    "https://github.com/example/policies/rules/5",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );

  // On: the card says what is in place.
  expect(
    await screen.findByText(/protects the policy on the/),
  ).toHaveTextContent("Ruleset protects the policy on the branch");
  expect(screen.getByRole("link", { name: "Ruleset" })).toHaveAttribute(
    "href",
    "https://github.com/example/policies/rules/5",
  );
  expect(screen.getByRole("link", { name: "branch" })).toHaveAttribute(
    "href",
    "https://github.com/example/policies/tree/main",
  );
  const link = await screen.findByRole("link", { name: "Pull request #12" });
  expect(link.closest("p")).toHaveTextContent(
    "Pull request #12 adds rules/servers/*.toml to appa.toml. Merge it and re-sync.",
  );
  expect(screen.queryByRole("button", { name: "Finish setup" })).toBeNull();
  // Once on, the row offers no switch of its own: Edit changes or turns it off.
  expect(screen.queryByRole("button", { name: "Enable" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Disable" })).toBeNull();
  expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
});

test("locks self-service while the environment variable sets it, naming the variable and its values", async () => {
  state = {
    ...state,
    source: { ...source, githubAppConfigId: "app-1", selfService: false },
    selfService: {
      enabled: true,
      setting: false,
      directory: "mcp",
      environment: {
        variable: "ARCHESTRA_OPENAPPA_SELF_SERVICE",
        value: "enabled",
      },
    },
  };
  server.use(
    http.get(`${url}/protection`, () =>
      HttpResponse.json({
        checkName: "Guardrails Policy Admission",
        include: { folder: "mcp", state: "included" },
        branchRules: { state: "missing" },
      }),
    ),
  );
  show();
  const locked = await screen.findByRole("combobox", {
    name: "MCP Guardrails Self-Service",
  });
  expect(locked).toHaveTextContent("On");
  expect(locked).toBeDisabled();
  expect(locked).toHaveAccessibleDescription(
    "Unset the environment variable to edit this setting.",
  );
  expect(
    screen.getByText(
      (_, element) =>
        element?.tagName === "CODE" &&
        element.textContent === "ARCHESTRA_OPENAPPA_SELF_SERVICE=enabled",
    ),
  ).toBeVisible();
  expect(
    screen.getByRole("button", {
      name: "MCP Guardrails Self-Service environment values",
    }),
  ).toBeEnabled();
  // In force: the protection shows all the same.
  expect(
    await screen.findByText(/No branch ruleset requires the/),
  ).toHaveTextContent(
    "No branch ruleset requires the Guardrails Policy Admission check yet. Import it with Finish setup.",
  );
});

test("self-service needs a GitHub App: a source without one cannot enable it", async () => {
  state = {
    ...state,
    source: { ...source, selfService: false },
    selfService: { enabled: false, setting: false, directory: "mcp" },
  };
  show();
  expect(await screen.findByRole("button", { name: "Enable" })).toBeDisabled();
  expect(
    screen.getByText(/Connect the policy repository through a GitHub App/),
  ).toBeVisible();
  expect(screen.getByRole("link", { name: /Learn more/ })).toHaveAttribute(
    "href",
    expect.stringContaining("git-sync#mcp-guardrails-self-service"),
  );
  expect(screen.queryByText(/Self-service branch protection/)).toBeNull();
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
    screen.queryByRole("button", { name: "Edit" }),
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
        selfService: false,
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
  // The Self-service step comes first; nothing to change here.
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
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
        selfService: false,
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
  // The Self-service step comes first; nothing to change here.
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
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
    http.get(`${url}/protection`, () =>
      HttpResponse.json({
        checkName: "Check OpenAPPA Guardrails",
        include: { folder: "mcp", state: "included" },
        branchRules: {
          state: "active",
          url: "https://github.com/example/policies/rules/5",
        },
      }),
    ),
  );
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  expect(await screen.findByText("Edit Git sync")).toBeVisible();
  expect(
    await screen.findByText("No traces/ folder", {}, { timeout: 3000 }),
  ).toBeVisible();
  // The repository already syncing is kept, not announced as a new find.
  expect(
    within(screen.getByRole("dialog")).queryByText(/becomes your policy/),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Branch")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  // With self-service on, the dialog stays open on what the save brought.
  const dialog = screen.getByRole("dialog");
  expect(
    await within(dialog).findByText("Git sync saved and the policy pulled"),
  ).toBeVisible();
  expect(
    await within(dialog).findByText(/requires the .* check on the branch/),
  ).toBeVisible();
  expect(await within(dialog).findByText(/already includes/)).toHaveTextContent(
    "appa.toml already includes mcp/*.toml.",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
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
    // Editing keeps the source's own self-service setting.
    githubAppConfigId: appId,
    selfService: true,
    selfServiceDirectory: "mcp",
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
      selfService: false,
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
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
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

test("asks for the GitHub and the organization, each error in place of its hint", async () => {
  state = { ...state, hasPolicy: false, source: null };
  server.use(
    http.get("http://localhost:9000/api/credentials", () =>
      HttpResponse.json([]),
    ),
  );
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: "Set up Git sync" }),
  );
  fireEvent.click(screen.getByRole("button", { name: /^GitHub/ }));

  const url = screen.getByLabelText("GitHub URL");
  const organization = screen.getByLabelText("Organization");
  expect(url).toHaveValue("https://github.com");
  expect(url).toHaveAccessibleDescription(
    "Using GitHub Enterprise Server? Put its address here.",
  );
  expect(organization).toHaveAccessibleDescription(
    "The GitHub organization for the policy repository.",
  );

  fireEvent.change(url, { target: { value: "not a url" } });
  fireEvent.change(organization, { target: { value: "-bad-" } });
  expect(url).toHaveAccessibleDescription(
    "Enter a web address, like https://github.com.",
  );
  expect(organization).toHaveAccessibleDescription(
    "Enter the organization's name on GitHub.",
  );
  expect(
    screen.getByRole("button", { name: /Use an existing repository/ }),
  ).toBeDisabled();
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

test("links the pull request that includes the servers' folder while it waits, and offers to finish the setup when a part is missing", async () => {
  state = {
    ...state,
    source: { ...source, githubAppConfigId: "app-1" },
  };
  let include: Record<string, unknown> = {
    folder: "mcp",
    state: "pull_open",
    pull: { number: 12, url: "https://github.com/example/policies/pull/12" },
  };
  server.use(
    http.get(`${url}/protection`, () =>
      HttpResponse.json({
        checkName: "Guardrails Policy Admission",
        include,
        branchRules: {
          state: "active",
          url: "https://github.com/example/policies/rules/5",
        },
      }),
    ),
    http.get(`${url}/app-grants`, () =>
      HttpResponse.json({
        name: "Policy App",
        url: "https://github.com/apps/policy-app",
        settingsUrl: "https://github.com/settings/apps/policy-app/permissions",
        installationUrl: "https://github.com/settings/installations/7",
        permissions: [
          { name: "contents", granted: true },
          { name: "pull_requests", granted: true },
          { name: "checks", granted: true },
        ],
      }),
    ),
  );
  show();
  const link = await screen.findByRole("link", { name: "Pull request #12" });
  expect(link).toHaveAttribute(
    "href",
    "https://github.com/example/policies/pull/12",
  );
  expect(link.closest("p")).toHaveTextContent(
    "Pull request #12 adds mcp/*.toml to appa.toml. Merge it and re-sync.",
  );
  expect(screen.queryByRole("button", { name: "Finish setup" })).toBeNull();

  cleanup();
  include = { folder: "mcp", state: "missing" };
  show();
  const finish = await screen.findByRole("button", { name: "Finish setup" });
  expect(finish.closest("p")).toHaveTextContent(
    "appa.toml does not include mcp/*.toml yet.",
  );
  // Already on: the setup starts at the App step, and the folder is fixed.
  fireEvent.click(finish);
  const dialog = await screen.findByRole("dialog", {
    name: "MCP Guardrails Self-Service",
  });
  expect(
    await within(dialog).findByText(/every permission self-service needs/),
  ).toBeVisible();
});
