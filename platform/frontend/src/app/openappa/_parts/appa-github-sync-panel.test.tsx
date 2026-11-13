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
};
/** Release 1.4: the status reports the deployment's variables. */
function selfServiceSetting(
  enabled: boolean,
  directory = "mcp",
  autoMerge = false,
) {
  return {
    enabled,
    directory,
    environment: {
      variable: "ARCHESTRA_OPENAPPA_SELF_SERVICE",
      value: enabled ? ("enabled" as const) : ("disabled" as const),
    },
    directoryEnvironment: {
      variable: "ARCHESTRA_OPENAPPA_SELF_SERVICE_DIRECTORY",
      value: directory,
    },
    autoMerge: {
      enabled: autoMerge,
      environment: {
        variable: "ARCHESTRA_OPENAPPA_SELF_SERVICE_AUTO_MERGE",
        value: autoMerge ? ("enabled" as const) : ("disabled" as const),
      },
    },
  };
}
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
    // Off unless a test turns the deployment's variable on.
    selfService: selfServiceSetting(false),
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

test("one Finish setup notice names what still waits, and its wizard takes the pieces at hand: the files update pull request, the App's permissions, the check", async () => {
  server.use(
    http.get(`${url}/protection`, () =>
      HttpResponse.json({
        checkName: "Guardrails Policy Admission",
        include: { folder: "mcp", state: "included" },
        branchRules: {
          state: "active",
          url: "https://github.com/example/policies/rules/5",
        },
      }),
    ),
  );
  state = {
    ...state,
    templateFiles: {
      templateCommit: "2302fc9b4a9921ea73910047fd1e98535c321112",
      state: "pull_open",
      paths: [".github/workflows/validate.yml", "README.md"],
      withheld: [],
      pull: { number: 4, url: "https://github.com/example/policies/pull/4" },
      checkedAt: new Date(Date.now() - 10_000).toISOString(),
    },
  };
  show();
  expect(await screen.findByText("Finish the Git sync setup")).toBeVisible();
  expect(screen.getByText("Merge PR #4.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
  let dialog = await screen.findByRole("dialog", {
    name: "Merge the pull request",
  });
  expect(
    within(dialog).getByRole("link", { name: "Repository files update #4" }),
  ).toHaveAttribute("href", "https://github.com/example/policies/pull/4");
  expect(within(dialog).getByText(/Waiting for merge/)).toBeVisible();
  expect(
    within(dialog).getByRole("link", { name: "Review and merge" }),
  ).toHaveAttribute("href", "https://github.com/example/policies/pull/4");
  // The pull request, then the Finish step, where Done syncs at once.
  expect(within(dialog).queryByText("GitHub App")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
  dialog = await screen.findByRole("dialog", { name: "Finish setup" });
  expect(
    await within(dialog).findByText(
      /updates the files beside the policy: waiting for merge/,
    ),
  ).toBeVisible();
  const actions: unknown[] = [];
  server.use(
    http.patch(url, async ({ request }) => {
      actions.push(await request.json());
      return HttpResponse.json(state);
    }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(actions).toEqual([{ action: "sync" }]));
  expect(screen.queryByRole("dialog")).toBeNull();
  cleanup();

  // The App may not write workflows: the pull request carries the rest, and
  // the wizard starts with the grant, then the pull requests.
  server.use(
    http.get(`${url}/app-grants`, () =>
      HttpResponse.json({
        name: "Policy App",
        url: "https://github.com/apps/policy-app",
        settingsUrl: "https://github.com/settings/apps/policy-app/permissions",
        installationUrl: "https://github.com/settings/installations/7",
        permissions: [{ name: "workflows", granted: false }],
      }),
    ),
  );
  state = {
    ...state,
    source: state.source && { ...state.source, githubAppConfigId: "app-1" },
    templateFiles: {
      templateCommit: "2302fc9b4a9921ea73910047fd1e98535c321112",
      state: "pull_open",
      paths: [".github/workflows/validate.yml", "README.md"],
      withheld: [".github/workflows/validate.yml"],
      detail:
        "The GitHub App cannot act on example/policies with Workflows (read and write).",
      pull: { number: 4, url: "https://github.com/example/policies/pull/4" },
      checkedAt: "2026-11-13T09:00:00Z",
    },
  };
  show();
  expect(
    await screen.findByText(
      "Grant the App's Workflows permission, merge PR #4.",
    ),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
  dialog = await screen.findByRole("dialog", {
    name: "Finish the GitHub App setup",
  });
  expect(
    await within(dialog).findByRole("button", { name: "Update App" }),
  ).toBeVisible();
  expect(dialog).toHaveTextContent(
    "Grant the Workflows permission to the Policy App App",
  );
  expect(within(dialog).getByText("Pull requests")).toBeVisible();
  expect(
    within(dialog).getByRole("button", { name: "Continue" }),
  ).toBeDisabled();
  cleanup();

  // The last check failed while the pull request waits: still the one to
  // merge, with the failure beside it.
  state = {
    ...state,
    templateFiles: {
      templateCommit: "2302fc9b4a9921ea73910047fd1e98535c321112",
      state: "unavailable",
      paths: [".github/workflows/validate.yml", "README.md"],
      withheld: [],
      pull: { number: 4, url: "https://github.com/example/policies/pull/4" },
      detail: "GitHub returned HTTP 502 while proposing the repository files.",
      checkedAt: "2026-11-13T09:00:00Z",
    },
  };
  show();
  expect(await screen.findByText("Merge PR #4.")).toBeVisible();
  expect(
    screen.getByText("Repository files could not be checked"),
  ).toBeVisible();
  cleanup();

  // Only the workflow differs and the check is refused: both permissions,
  // no pull request yet.
  state = {
    ...state,
    templateFiles: {
      templateCommit: "2302fc9b4a9921ea73910047fd1e98535c321112",
      state: "needs_permission",
      paths: [".github/workflows/validate.yml"],
      withheld: [".github/workflows/validate.yml"],
      detail:
        "The GitHub App cannot act on example/policies with Workflows (read and write).",
      checkedAt: "2026-11-13T09:00:00Z",
    },
    check: {
      name: "Check OpenAPPA Guardrails",
      state: "refused",
      detail: "a GitHub App needs the Checks permission (read and write)",
    },
  };
  show();
  expect(
    await screen.findByText(
      "Grant the App's Workflows and Checks permissions.",
    ),
  ).toBeVisible();
  cleanup();

  // Current files and a posted check show nothing.
  state = {
    ...state,
    templateFiles: {
      templateCommit: "2302fc9b4a9921ea73910047fd1e98535c321112",
      state: "current",
      paths: [],
      checkedAt: "2026-11-13T09:00:00Z",
    },
    check: { name: "Check OpenAPPA Guardrails", state: "posted" },
  };
  show();
  expect(await screen.findByText("Connected")).toBeVisible();
  expect(screen.queryByText(/Finish the Git sync setup/)).toBeNull();
});

test("a source read with an access token is not sent to grant an App Workflows: the card says what its token lacks", async () => {
  state = {
    ...state,
    source: { ...source, githubPatId: "pat-1" },
    selfService: selfServiceSetting(false),
    templateFiles: {
      templateCommit: "2302fc9b4a9921ea73910047fd1e98535c321112",
      state: "pull_open",
      paths: [".github/workflows/validate.yml", "README.md"],
      withheld: [".github/workflows/validate.yml"],
      detail:
        "The access token lacks the workflow scope, so it cannot write the validation workflow. Give the token that scope.",
      pull: { number: 4, url: "https://github.com/example/policies/pull/4" },
      checkedAt: "2026-11-13T09:00:00Z",
    },
  };
  show();
  expect(await screen.findByText("Merge PR #4.")).toBeVisible();
  expect(screen.queryByText(/Workflows permission/)).toBeNull();
  expect(
    screen.getByText("Repository files could not be updated"),
  ).toBeVisible();
  expect(screen.getByText(/lacks the workflow scope/)).toBeVisible();
});

test("a branch rule left behind with self-service off is named, and the card says the check is still posted", async () => {
  state = {
    ...state,
    source: { ...source, githubAppConfigId: "app-1" },
    selfService: {
      ...selfServiceSetting(false),
      leftoverRule: {
        checkName: "Check OpenAPPA Guardrails",
        url: "https://github.com/example/policies/rules/5",
      },
    },
  };
  server.use(
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
  const ruleset = await screen.findByRole("link", { name: "ruleset" });
  expect(ruleset).toHaveAttribute(
    "href",
    "https://github.com/example/policies/rules/5",
  );
  expect(ruleset.closest("p")).toHaveTextContent(
    "keeps posting it, so pull requests merge once it passes. Remove the rule before you move or stop Git sync.",
  );
});

test("a ruleset still to set up: the row says ready to be Enabled, with Finish setup, and no sentence under it", async () => {
  state = {
    ...state,
    source: { ...source, githubAppConfigId: "app-1" },
    selfService: selfServiceSetting(true),
  };
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
  expect(
    await screen.findByRole("heading", {
      name: "MCP Guardrails Self-Service is ready to be Enabled",
    }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Finish setup" })).toBeEnabled();
  expect(screen.queryByText(/branch protection/)).toBeNull();
  expect(screen.queryByRole("link", { name: "ruleset" })).toBeNull();
});

test("on in full: the row says Enabled and names the ruleset", async () => {
  state = {
    ...state,
    source: { ...source, githubAppConfigId: "app-1" },
    selfService: selfServiceSetting(true),
  };
  server.use(
    http.get(`${url}/protection`, () =>
      HttpResponse.json({
        checkName: "Guardrails Policy Admission",
        include: { folder: "mcp", state: "included" },
        branchRules: {
          state: "active",
          url: "https://github.com/example/policies/rules/5",
        },
      }),
    ),
  );
  show();
  expect(
    await screen.findByRole("heading", {
      name: "MCP Guardrails Self-Service is Enabled",
    }),
  ).toBeVisible();
  expect(
    await screen.findByText(/protects the policy on the/),
  ).toHaveTextContent("Ruleset protects the policy on the branch");
  expect(screen.getByRole("link", { name: "Ruleset" })).toHaveAttribute(
    "href",
    "https://github.com/example/policies/rules/5",
  );
  expect(screen.queryByRole("button", { name: "Finish setup" })).toBeNull();
});

test("a rule the App cannot post the check for: the row says ready to be Enabled, says the rule holds pull requests, and offers Finish setup", async () => {
  state = {
    ...state,
    source: { ...source, githubAppConfigId: "app-1" },
    selfService: selfServiceSetting(true),
  };
  server.use(
    http.get(`${url}/protection`, () =>
      HttpResponse.json({
        checkName: "Guardrails Policy Admission",
        include: { folder: "mcp", state: "included" },
        app: { name: "Policy App", url: "https://github.com/apps/policy-app" },
        branchRules: {
          state: "active",
          url: "https://github.com/example/policies/rules/5",
          checkRule: "unposted",
          detail:
            "The GitHub App needs the Checks permission (read and write).",
        },
      }),
    ),
  );
  show();
  expect(
    await screen.findByRole("heading", {
      name: "MCP Guardrails Self-Service is ready to be Enabled",
    }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Finish setup" })).toBeEnabled();
  expect(
    await screen.findByText(/holds pull requests until the/),
  ).toHaveTextContent(
    "The Self-service branch protection ruleset holds pull requests until the Policy App App can post the check.",
  );
  expect(screen.queryByText(/protects the policy on the/)).toBeNull();
});

test("Finish setup lists the permissions an existing GitHub App lacks, with where to grant and accept them", async () => {
  state = {
    ...state,
    source: { ...source, githubAppConfigId: "app-1" },
    selfService: selfServiceSetting(true),
  };
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
    await screen.findByRole("heading", {
      name: "MCP Guardrails Self-Service is ready to be Enabled",
    }),
  ).toBeVisible();
  expect(screen.queryByText(/Administration permission/)).toBeNull();
  expect(
    screen.getByText(
      "Grant the App's Checks permission, finish the self-service protection.",
    ),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Finish the GitHub App setup",
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
  expect(within(dialog).getByText(/has the Checks permission/)).toBeVisible();
});

test("Finish setup walks through the include pull request and the ruleset the administrator imports, from the card's one notice", async () => {
  state = {
    ...state,
    source: { ...source, githubAppConfigId: "app-1" },
    selfService: selfServiceSetting(true, "rules/servers"),
  };
  let include: Record<string, unknown> = {
    folder: "rules/servers",
    state: "missing",
  };
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
      const body = (await request.json()) as { action: string };
      actions.push(body);
      // Only the include row's button opens the pull request.
      if (body.action === "include_servers")
        include = {
          folder: "rules/servers",
          state: "pull_open",
          pull: {
            number: 12,
            url: "https://github.com/example/policies/pull/12",
          },
        };
      return HttpResponse.json(state);
    }),
  );
  show();
  // On by the variable, but not in full: the heading says so, and the
  // card's one notice finishes it; no sentence repeats what is missing.
  expect(
    await screen.findByRole("heading", {
      name: "MCP Guardrails Self-Service is ready to be Enabled",
    }),
  ).toBeVisible();
  expect(screen.queryByText(/does not include/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Enable" })).toBeNull();
  expect(
    await screen.findByText("Finish the self-service protection."),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
  // Nothing else waits: the wizard is the Finish step alone.
  const dialog = await screen.findByRole("dialog", { name: "Finish setup" });

  // The missing include waits for its button, which opens the pull request.
  expect(
    (
      await within(dialog).findAllByText(
        (_, element) =>
          element?.tagName === "SPAN" &&
          element.textContent ===
            "appa.toml does not include rules/servers/*.toml yet.",
      )
    )[0],
  ).toBeVisible();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Open the pull request" }),
  );
  expect(
    (await within(dialog).findByRole("link", { name: "Pull request #12" }))
      .parentElement,
  ).toHaveTextContent(
    "Pull request #12 opened. Merge it and re-sync to apply the new settings.",
  );
  expect(actions).toEqual([{ action: "include_servers" }]);
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
  // Done syncs at once.
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(actions).toContainEqual({ action: "sync" }));

  // Until the pull request merges, the card points at it, and the notice
  // asks for its merge.
  const link = await screen.findByRole("link", { name: "Pull request #12" });
  expect(
    screen.getByRole("heading", {
      name: "MCP Guardrails Self-Service is ready to be Enabled",
    }),
  ).toBeVisible();
  expect(screen.queryByText(/protects the policy on the/)).toBeNull();
  expect(link.closest("p")).toHaveTextContent(
    "Pull request #12 adds rules/servers/*.toml to appa.toml. Merge it and re-sync.",
  );
  expect(screen.getByText("Merge PR #12.")).toBeVisible();
  // The variables are the switch: the card offers none of its own.
  expect(screen.queryByRole("button", { name: "Disable" })).toBeNull();
  expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
});

test("shows the deployment's self-service settings read-only, naming the variables and their values", async () => {
  state = {
    ...state,
    source: { ...source, githubAppConfigId: "app-1" },
    selfService: selfServiceSetting(true),
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
  // The ruleset is not up yet: the heading says ready, in plain weight.
  expect(
    await screen.findByRole("heading", {
      name: "MCP Guardrails Self-Service is ready to be Enabled",
    }),
  ).toBeVisible();
  expect(screen.queryByText("On", { selector: "p" })).toBeNull();
  expect(
    screen.queryByRole("combobox", { name: "MCP Guardrails Self-Service" }),
  ).toBeNull();
  const code = (text: string) =>
    screen.getByText(
      (_, element) =>
        element?.tagName === "CODE" && element.textContent === text,
    );
  expect(code("ARCHESTRA_OPENAPPA_SELF_SERVICE=enabled")).toBeVisible();
  expect(
    screen.getByRole("button", {
      name: "MCP Guardrails Self-Service environment values",
    }),
  ).toBeEnabled();
  // The folder too, named in its sentence and not in a value column, with
  // no other values to list.
  expect(
    screen.getByText(
      (_, element) =>
        element?.tagName === "STRONG" && element.textContent === "mcp/",
    ),
  ).toBeVisible();
  expect(screen.queryByText("mcp/", { selector: "p" })).toBeNull();
  expect(code("ARCHESTRA_OPENAPPA_SELF_SERVICE_DIRECTORY=mcp")).toBeVisible();
  expect(
    screen.queryByRole("button", {
      name: "Self-service folder environment values",
    }),
  ).toBeNull();
  // Auto-merge too, off here: people merge the pull requests.
  expect(
    screen.getByText(
      "Someone with write access to the repository merges admitted self-service pull requests.",
    ),
  ).toBeVisible();
  expect(
    code("ARCHESTRA_OPENAPPA_SELF_SERVICE_AUTO_MERGE=disabled"),
  ).toBeVisible();
  // The ruleset is not up yet: ready, with Finish setup.
  expect(
    await screen.findByRole("heading", {
      name: "MCP Guardrails Self-Service is ready to be Enabled",
    }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Finish setup" })).toBeEnabled();
});

test("with auto-merge on, the card says admitted self-service pull requests merge automatically, and names the variable", async () => {
  state = {
    ...state,
    source: { ...source, githubAppConfigId: "app-1" },
    selfService: selfServiceSetting(true, "mcp", true),
  };
  server.use(
    http.get(`${url}/protection`, () =>
      HttpResponse.json({
        checkName: "Guardrails Policy Admission",
        include: { folder: "mcp", state: "included" },
        branchRules: { state: "active" },
      }),
    ),
  );
  show();
  expect(
    await screen.findByText(
      "Admitted self-service pull requests merge automatically.",
    ),
  ).toBeVisible();
  expect(
    screen.getByText(
      (_, element) =>
        element?.tagName === "CODE" &&
        element.textContent ===
          "ARCHESTRA_OPENAPPA_SELF_SERVICE_AUTO_MERGE=enabled",
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole("combobox", { name: "Auto-merge pull requests" }),
  ).toBeNull();
});

test("self-service needs a GitHub App: a source without one gets no check or ruleset", async () => {
  state = {
    ...state,
    source: { ...source },
    selfService: selfServiceSetting(false),
  };
  show();
  expect(
    await screen.findByText(
      (_, element) =>
        element?.tagName === "STRONG" && element.textContent === "Disabled",
    ),
  ).toBeVisible();
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
  server.use(http.patch(url, () => HttpResponse.json(state)));
  fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));
  // The Finish step follows the connect, and Done closes it.
  const checklist = await screen.findByRole("dialog", { name: "Finish setup" });
  expect(
    await within(checklist).findByText(
      "Repository connected and the policy pulled",
    ),
  ).toBeVisible();
  fireEvent.click(within(checklist).getByRole("button", { name: "Done" }));
  expect(await screen.findByText("Waiting for the first sync")).toBeVisible();
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
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
  // Checks is among the permissions every App gets, self-service or not.
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  // The new template copy is picked without a search.
  expect(
    await screen.findByText("OpenAPPA template", {}, { timeout: 3000 }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));
  // Repository rules require a pull request: the Finish step waits on it.
  const checklist = await screen.findByRole("dialog", { name: "Finish setup" });
  expect(
    await within(checklist).findByText(
      /carries the initial policy: waiting for merge/,
    ),
  ).toBeVisible();
  expect(
    within(checklist).getByRole("link", { name: "PR #7" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/example/openappa-policy/pull/7",
  );
  // Not merged yet: the check stays quiet, since the Finish step says so.
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
  expect(
    within(checklist).getByText(
      /carries the initial policy: waiting for merge/,
    ),
  ).toBeVisible();
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
  expect(
    await within(checklist).findByText(/^The policy syncs from/),
  ).toBeVisible();
  expect(toast.success).toHaveBeenCalledWith(
    "Initial policy merged. Policy synced from GitHub.",
  );
  fireEvent.click(within(checklist).getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

test("editing an App-backed source keeps its repository and only warns about missing validations", async () => {
  // On: the save's outcome stays on screen, the ruleset and the include.
  state = {
    ...state,
    source: { ...source, githubAppConfigId: appId },
    selfService: selfServiceSetting(true),
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
  // Every earlier step opens again, as for a new setup: the organization
  // and the start choice, then the App, where another can be created.
  const stepper = screen.getByRole("list", { name: "Setup progress" });
  fireEvent.click(within(stepper).getByRole("button", { name: /Start/ }));
  expect(screen.getByLabelText("Organization")).toHaveValue("example");
  fireEvent.click(screen.getByText("Use an existing repository"));
  expect(
    await screen.findByRole("radio", { name: /Policy App/ }),
  ).toBeChecked();
  expect(
    screen.getByRole("button", { name: "Create a new GitHub App instead" }),
  ).toBeVisible();
  fireEvent.click(within(stepper).getByRole("button", { name: /Repository/ }));
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
    githubAppConfigId: appId,
  });
});

test("connecting an existing repository with self-service keeps the checklist open on the setup pull request, with the ruleset to import", async () => {
  // On by the deployment's variable: the connect step stays open on what it brought.
  state = {
    ...state,
    hasPolicy: true,
    source: null,
    selfService: selfServiceSetting(true),
  };
  serveApps([[appId, "Policy App"]]);
  serveRepositories({ [appId]: ["example/policies"] });
  const actions: unknown[] = [];
  server.use(
    http.get(`${githubApp}/repository`, () =>
      HttpResponse.json({ status: "policy", validations: true }),
    ),
    http.post(`${url}/repository`, async ({ request }) => {
      expect(await request.json()).toEqual({
        owner: "example",
        name: "policies",
        githubAppConfigId: appId,
        interval: "1h",
        existing: true,
        replace: false,
      });
      // The repository holds its own policy: the current one goes in as a
      // pull request, the servers' include with it.
      state = {
        ...state,
        source: {
          ...source,
          githubAppConfigId: appId,
          sourceCommit: null,
          setupPullRequestNumber: 8,
        },
      };
      return HttpResponse.json(state);
    }),
    http.get(`${url}/protection`, () =>
      HttpResponse.json({
        checkName: "Check OpenAPPA Guardrails",
        include: {
          folder: "mcp",
          state: "pull_open",
          pull: {
            number: 8,
            url: "https://github.com/example/policies/pull/8",
          },
        },
        branchRules: {
          state: "missing",
          settingsUrl: "https://github.com/example/policies/settings/rules",
          ruleset: { name: "Check OpenAPPA Guardrails" },
        },
      }),
    ),
    http.patch(url, async ({ request }) => {
      actions.push(await request.json());
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
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Connect repository" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));
  // No separate pull request dialog: the checklist names the setup pull
  // request, the ruleset to import, and the include the pull request carries.
  const dialog = await screen.findByRole("dialog");
  const setup = await within(dialog).findByRole("link", {
    name: "Pull request #8",
  });
  expect(setup).toHaveAttribute(
    "href",
    "https://github.com/example/policies/pull/8",
  );
  expect(setup.parentElement).toHaveTextContent(
    "Repository connected. Pull request #8 carries the current policy: merge it, and the next sync finishes setup.",
  );
  expect(
    await within(dialog).findByRole("button", { name: "Download ruleset" }),
  ).toBeVisible();
  expect(
    within(dialog).getByText(/The setup pull request includes/),
  ).toHaveTextContent("The setup pull request includes mcp/*.toml.");
  // Nothing else opened: the pull request on its way is the include.
  expect(actions).toEqual([]);
  expect(screen.queryByText("Finish Git sync")).not.toBeInTheDocument();
  // Without the Checks permission the import waits: a rule requiring a
  // check nobody posts would hold every pull request, so no file to import.
  server.use(
    http.get(`${url}/protection`, () =>
      HttpResponse.json({
        checkName: "Check OpenAPPA Guardrails",
        include: {
          folder: "mcp",
          state: "pull_open",
          pull: {
            number: 8,
            url: "https://github.com/example/policies/pull/8",
          },
        },
        branchRules: {
          state: "needs_permission",
          detail:
            "The GitHub App needs the Checks permission (read and write).",
          settingsUrl: "https://github.com/example/policies/settings/rules",
          ruleset: { name: "Check OpenAPPA Guardrails" },
        },
      }),
    ),
  );
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "Check the branch rules again",
    }),
  );
  expect(
    await within(dialog).findByText(/Grant it with Finish setup/),
  ).toHaveTextContent(
    "The GitHub App needs the Checks permission (read and write). Grant it with Finish setup on the Git sync card, then import the ruleset.",
  );
  expect(
    within(dialog).queryByRole("button", { name: "Download ruleset" }),
  ).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: "Open rulesets" }),
  ).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
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

test("keeps the merge notice after reload, and Done in the wizard syncs at once so the notice goes once the merge is pulled", async () => {
  state = {
    ...state,
    source: { ...source, setupPullRequestNumber: 7, sourceCommit: null },
  };
  show();
  expect(await screen.findByText("Merge PR #7.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
  const pulls = await screen.findByRole("dialog", {
    name: "Merge the pull request",
  });
  expect(
    within(pulls).getByRole("link", { name: "Initial policy #7" }),
  ).toHaveAttribute("href", "https://github.com/example/policies/pull/7");
  fireEvent.click(within(pulls).getByRole("button", { name: "Continue" }));
  const dialog = await screen.findByRole("dialog", { name: "Finish setup" });
  // Merged on GitHub meanwhile: Done syncs at once, the card shows the sync
  // running, and the notice goes once it lands.
  let finish!: () => void;
  const landed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  server.use(
    http.patch(url, async () => {
      await landed;
      state = { ...state, source };
      return HttpResponse.json(state);
    }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(
    await screen.findByRole("button", { name: "Syncing…" }),
  ).toBeDisabled();
  finish();
  await waitFor(() =>
    expect(screen.queryByText("Merge PR #7.")).not.toBeInTheDocument(),
  );
  expect(screen.getByText("Connected")).toBeVisible();
});

test("links the pull request that includes the servers' folder while it waits, and offers to finish the setup when a part is missing", async () => {
  state = {
    ...state,
    source: { ...source, githubAppConfigId: "app-1" },
    selfService: selfServiceSetting(true),
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
  expect(screen.getByText("Merge PR #12.")).toBeVisible();

  cleanup();
  include = { folder: "mcp", state: "missing" };
  server.use(http.patch(url, () => HttpResponse.json(state)));
  show();
  expect(
    await screen.findByText("Finish the self-service protection."),
  ).toBeVisible();
  expect(screen.queryByText(/does not include/)).toBeNull();
  expect(
    screen.getByRole("heading", {
      name: "MCP Guardrails Self-Service is ready to be Enabled",
    }),
  ).toBeVisible();
  // Already on: the wizard is the Finish step alone, and the missing include
  // waits for its button.
  fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
  const dialog = await screen.findByRole("dialog", { name: "Finish setup" });
  expect(
    (
      await within(dialog).findAllByText(
        (_, element) =>
          element?.tagName === "SPAN" &&
          element.textContent === "appa.toml does not include mcp/*.toml yet.",
      )
    )[0],
  ).toBeVisible();
  expect(
    within(dialog).getByRole("button", { name: "Open the pull request" }),
  ).toBeVisible();
});
