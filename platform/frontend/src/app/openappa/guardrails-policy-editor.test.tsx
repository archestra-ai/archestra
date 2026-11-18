import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useSearchParams } from "next/navigation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import { invalidatePolicyViews } from "@/lib/openappa-policy-views";
import { makeSession, makeUserPermissions } from "@/mocks/data/auth";
import { GuardrailsPolicyEditor } from "./guardrails-policy-editor";

vi.mock("@/components/editor");
vi.mock("next/navigation");
vi.mock("sonner");
vi.mock("@/lib/clients/auth/auth-client");
// The registry's own launch link, which needs the Keeper agent and the config.
vi.mock("@/app/mcp/registry/_parts/server-rules-launch", () => ({
  SERVER_RULES_LABEL: "Edit Guardrails",
  ServerRulesButton: ({
    catalog,
    children,
  }: {
    catalog: { id: string };
    children: React.ReactNode;
  }) => <a href={`/chat?server=${catalog.id}`}>{children}</a>,
}));
const origin = "http://localhost:9000";
const url = `${origin}/api/guardrails-policy`;
const content = "[policy]\nversion = 2\n";
const policy = {
  organizationId: "org",
  revision: 1,
  content,
  contentHash: "hash",
  updatedBy: null,
  updatedAt: null,
};
const declarationsUrl = `${origin}/api/openappa/policy-declarations`;
const effectiveUrl = `${origin}/api/openappa/effective-policy`;
const current = {
  served: {
    kind: "current",
    rootRevision: 1,
    composedAt: "2026-01-01T00:00:00.000Z",
  },
  refusal: null,
};
const declarations = {
  batteries: [],
  repositoryFiles: [],
  unusedAliases: [],
  rootRevision: 1,
  lastError: null,
  composition: current,
  managedInGithub: false,
};
function battery(
  name: string,
  status: string,
  line: number,
  composed = status === "active",
) {
  return {
    entry: `${name}/policy.toml`,
    name,
    source: "bundled",
    packageHash: null,
    status,
    line,
    composed,
    servers: [],
    credentials: [],
    helpers: [],
    served: { status, composed },
  };
}
const effective = {
  organizationId: "org",
  content: `${content}[acme]\n`,
  contentHash: "0123456789abcdef",
  rootRevision: 1,
  installFingerprint: "fingerprint",
  compiledAt: "2026-01-01T00:00:00.000Z",
  lastError: null,
  lastErrorAt: null,
  composition: current,
};
let effectiveRequests = 0;
let pushState: MockInstance<typeof window.history.pushState>;
const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  // The file palette scrolls its selected item into view; jsdom has no layout.
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: makeSession(),
    error: null,
  } as Awaited<ReturnType<typeof authClient.getSession>>);
  archestraApiClient.setConfig({ baseUrl: origin });
  vi.mocked(usePathname).mockReturnValue("/openappa/policy");
  // Opening a file moves the URL; the test reads where to and remounts there.
  pushState = vi
    .spyOn(window.history, "pushState")
    .mockImplementation(() => {});
  window.localStorage.clear();
  effectiveRequests = 0;
  server.use(
    http.get(`${origin}/api/user/permissions`, () =>
      HttpResponse.json(makeUserPermissions()),
    ),
    http.get(`${origin}/api/agents/chat-roster`, () =>
      HttpResponse.json([
        {
          id: "appa-agent",
          name: "Configuration Agent",
          scope: "org",
          builtIn: true,
          builtInAgentConfig: { name: "openappa-configuration-agent" },
          authorId: null,
          labels: [],
        },
      ]),
    ),
    http.get(url, () => HttpResponse.json(policy)),
    http.get(`${origin}/api/openappa/github-sync`, () =>
      HttpResponse.json({ enabled: true, source: null, hasPolicy: false }),
    ),
    http.get(declarationsUrl, () => HttpResponse.json(declarations)),
    http.get(effectiveUrl, () => {
      effectiveRequests += 1;
      return HttpResponse.json(effective);
    }),
  );
});
afterEach(() => {
  server.resetHandlers();
  pushState.mockRestore();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function mount(query = "") {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>,
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <GuardrailsPolicyEditor />
    </QueryClientProvider>,
  );
  return client;
}
const entryQuery = (entry: string) => new URLSearchParams({ entry }).toString();
/** The URL the page last moved to. */
const lastUrl = () => pushState.mock.calls.at(-1)?.[2];

test("the policy source says how an editor can change it", async () => {
  mount();

  expect(
    await screen.findByRole("textbox", {
      name: "Organization guardrails policy",
    }),
  ).toHaveAttribute("readonly");
  expect(
    await screen.findByRole("img", {
      name: "Read-only. Change this policy with the configuration agent in chat.",
    }),
  ).toBeVisible();
  expect(
    await screen.findByRole("link", { name: "Change in chat" }),
  ).toHaveAttribute("href", "/chat?agentId=appa-agent");
});

test("a reader sees the policy without a change action", async () => {
  server.use(
    http.get(`${origin}/api/user/permissions`, () =>
      HttpResponse.json(makeUserPermissions({ guardrailsPolicy: ["read"] })),
    ),
  );
  mount();

  expect(
    await screen.findByRole("textbox", {
      name: "Organization guardrails policy",
    }),
  ).toHaveAttribute("readonly");
  expect(
    screen.getByRole("img", {
      name: "Read-only. Ask an administrator to change this policy.",
    }),
  ).toBeVisible();
  expect(
    screen.queryByRole("link", { name: "Change in chat" }),
  ).not.toBeInTheDocument();
});

test("a repository-owned policy points editors to its repository", async () => {
  server.use(
    http.get(declarationsUrl, () =>
      HttpResponse.json({ ...declarations, managedInGithub: true }),
    ),
    http.get(`${origin}/api/openappa/github-sync`, () =>
      HttpResponse.json({
        enabled: true,
        githubWebUrl: "https://github.com",
        source: {
          repo: "example/policies",
          ref: "main",
          path: "appa.toml",
          lastSyncError: null,
        },
      }),
    ),
  );
  mount();

  expect(
    await screen.findByRole("textbox", {
      name: "Organization guardrails policy",
    }),
  ).toHaveAttribute("readonly");
  expect(
    await screen.findByRole("img", {
      name: "Read-only. Change this policy in its connected repository.",
    }),
  ).toBeVisible();
  expect(
    await screen.findByRole("link", { name: "Edit in repository" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/example/policies/edit/main/appa.toml",
  );
  expect(
    screen.getByRole("link", { name: "Managed in GitHub" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/example/policies/blob/main/appa.toml",
  );
  // The repository names the root file; the explorer shows it under that name.
  expect(
    within(screen.getByRole("navigation", { name: "Policy files" })).getByRole(
      "button",
      { name: "appa.toml" },
    ),
  ).toHaveAttribute("aria-current", "page");
  expect(
    screen.queryByRole("link", { name: "Change in chat" }),
  ).not.toBeInTheDocument();
});

test("the explorer separates the organization policy from its batteries, and a battery opens as one", async () => {
  const githubEntry = "batteries/github/appa.toml";
  server.use(
    http.get(declarationsUrl, () =>
      HttpResponse.json({
        ...declarations,
        batteries: [
          { ...battery("github", "active", 3), entry: githubEntry },
          battery("pending", "missing_credentials", 4),
        ],
      }),
    ),
    http.get(`${origin}/api/openappa/battery-policy-source`, ({ request }) => {
      expect(new URL(request.url).searchParams.get("entry")).toBe(githubEntry);
      return HttpResponse.json({
        entry: githubEntry,
        name: "github",
        content: '[[policy.tool]]\nname = "mcp/github/get_commit"\n',
      });
    }),
  );
  mount(entryQuery(githubEntry));

  expect(
    await screen.findByRole("textbox", {
      name: "GitHub battery policy TOML",
    }),
  ).toHaveValue('[[policy.tool]]\nname = "mcp/github/get_commit"\n');
  expect(
    screen.queryByRole("textbox", {
      name: "Organization guardrails policy",
    }),
  ).not.toBeInTheDocument();

  const explorer = screen.getByRole("navigation", { name: "Policy files" });
  expect(
    within(explorer).getByRole("button", { name: "Organization policy" }),
  ).toHaveAttribute("aria-expanded", "true");
  // Two batteries, each in its own folder, under the Batteries section.
  expect(
    await within(explorer).findByRole("button", { name: /^Batteries\s*2$/ }),
  ).toBeVisible();
  expect(
    within(explorer).getByRole("button", { name: /appa\.toml\s*Enforced/ }),
  ).toHaveAttribute("aria-current", "page");
  expect(
    within(explorer).getByRole("button", {
      name: /policy\.toml\s*Needs a credential/,
    }),
  ).not.toHaveAttribute("aria-current");
  // The bar names what is open, so a battery never reads as the organization's text.
  expect(screen.getByTestId("policy-file-kind")).toHaveTextContent("Battery");

  await userEvent.click(
    within(explorer).getByRole("button", { name: "policy.toml" }),
  );
  expect(lastUrl()).toBe("/openappa/policy");
});

test("the file palette searches batteries by their status and opens the chosen file", async () => {
  server.use(
    http.get(declarationsUrl, () =>
      HttpResponse.json({
        ...declarations,
        batteries: [
          battery("acme", "active", 3),
          battery("globex", "missing_credentials", 4),
        ],
      }),
    ),
  );
  mount();
  await screen.findByRole("textbox", {
    name: "Organization guardrails policy",
  });

  await userEvent.click(
    screen.getByRole("button", { name: "Open a policy file" }),
  );
  await userEvent.type(
    await screen.findByPlaceholderText("Go to file"),
    "credential",
  );
  expect(screen.getByRole("option", { name: /globex/ })).toBeVisible();
  expect(
    screen.queryByRole("option", { name: /acme/ }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("option", { name: /globex/ }));
  expect(lastUrl()).toBe(
    `/openappa/policy?${entryQuery("globex/policy.toml")}`,
  );
});

test("the explorer lists the repository's files in their folders, and a file opens read-only with its edit link", async () => {
  const entry = "mcp/payments_api.toml";
  const text =
    '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "payments_api__refund_payment"\n';
  server.use(
    http.get(declarationsUrl, () =>
      HttpResponse.json({
        ...declarations,
        managedInGithub: true,
        repositoryFiles: [{ path: entry }, { path: "shared/rules.toml" }],
      }),
    ),
    http.get(`${origin}/api/openappa/github-sync`, () =>
      HttpResponse.json({
        enabled: true,
        hasPolicy: true,
        githubWebUrl: "https://github.com",
        provider: "github",
        source: { repo: "example/policies", ref: "main", path: "appa.toml" },
        selfService: { enabled: true, setting: true, directory: "mcp" },
      }),
    ),
    http.get(`${origin}/api/openappa/battery-policy-source`, ({ request }) => {
      expect(new URL(request.url).searchParams.get("entry")).toBe(entry);
      return HttpResponse.json({
        entry,
        name: entry,
        kind: "repository",
        content: text,
      });
    }),
  );
  mount();
  const explorer = screen.getByRole("navigation", { name: "Policy files" });
  expect(
    await within(explorer).findByRole("button", {
      name: /^Repository files\s*2$/,
    }),
  ).toBeVisible();
  expect(within(explorer).getByRole("button", { name: "mcp" })).toBeVisible();
  expect(
    within(explorer).getByRole("button", { name: "shared" }),
  ).toBeVisible();
  expect(
    within(explorer).getByRole("button", { name: "rules.toml" }),
  ).toBeVisible();
  await userEvent.click(
    within(explorer).getByRole("button", { name: "payments_api.toml" }),
  );
  expect(lastUrl()).toBe(`/openappa/policy?${entryQuery(entry)}`);
  cleanup();

  mount(entryQuery(entry));
  expect(
    await screen.findByRole("textbox", { name: "mcp/payments_api.toml TOML" }),
  ).toHaveValue(text);
  await waitFor(() =>
    expect(screen.getByTestId("policy-file-kind")).toHaveTextContent(
      "MCP server rules",
    ),
  );
  expect(
    screen.getByRole("img", {
      name: "Read-only. Change this file in its connected repository.",
    }),
  ).toBeVisible();
  expect(
    await screen.findByRole("link", { name: "Edit in repository" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/example/policies/edit/main/mcp/payments_api.toml",
  );
});

test("battery source remains available when root policy and GitHub sync fail", async () => {
  const entry = "batteries/github/appa.toml";
  server.use(
    http.get(url, () => new HttpResponse(null, { status: 500 })),
    http.get(
      `${origin}/api/openappa/github-sync`,
      () => new HttpResponse(null, { status: 500 }),
    ),
    http.get(`${origin}/api/openappa/battery-policy-source`, () =>
      HttpResponse.json({
        entry,
        name: "github",
        content: '[[policy.tool]]\nname = "mcp/github/get_commit"\n',
      }),
    ),
  );
  mount(entryQuery(entry));
  expect(
    await screen.findByRole("textbox", { name: "GitHub battery policy TOML" }),
  ).toHaveValue('[[policy.tool]]\nname = "mcp/github/get_commit"\n');
});

test("policy invalidation refreshes the displayed battery source", async () => {
  const entry = "batteries/github/appa.toml";
  let batteryContent = 'name = "mcp/github/get_commit"';
  server.use(
    http.get(`${origin}/api/openappa/battery-policy-source`, () =>
      HttpResponse.json({
        entry,
        name: "github",
        content: batteryContent,
      }),
    ),
  );
  const client = mount(entryQuery(entry));
  const source = await screen.findByRole("textbox", {
    name: "GitHub battery policy TOML",
  });
  expect(source).toHaveValue(batteryContent);
  batteryContent = 'name = "mcp/github/get_issue"';
  await invalidatePolicyViews(client);
  await waitFor(() => expect(source).toHaveValue(batteryContent));
});

test("the outline lists the open file's rules, and a rule opens at its line", async () => {
  server.use(
    http.get(url, () =>
      HttpResponse.json({
        ...policy,
        content:
          '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "docs__read"\n\n[[policy.tool]]\nname = "blog__publish"\n',
      }),
    ),
  );
  mount();
  const outline = screen.getByRole("complementary", { name: "Rule outline" });
  await userEvent.click(
    await within(outline).findByRole("button", { name: /blog__publish/ }),
  );
  expect(lastUrl()).toBe("/openappa/policy?line=8");
  expect(
    within(outline).getByRole("button", { name: /docs__read/ }),
  ).toBeVisible();
  cleanup();

  // The rule the line falls in is the outline's current one.
  mount("line=8");
  expect(
    await within(
      screen.getByRole("complementary", { name: "Rule outline" }),
    ).findByRole("button", { name: /blog__publish/ }),
  ).toHaveAttribute("aria-current", "location");
  expect(screen.getByText("Line 8")).toBeVisible();
});

test("the explorer counts the batteries the composition does not enforce", async () => {
  server.use(
    http.get(declarationsUrl, () =>
      HttpResponse.json({
        ...declarations,
        batteries: [
          battery("acme", "active", 3),
          battery("globex", "missing_credentials", 5),
          battery("initech", "active", 7),
        ],
      }),
    ),
  );
  mount();
  expect(
    await screen.findByRole("link", { name: "1 not enforced" }),
  ).toHaveAttribute("href", "/openappa/batteries?status=attention");
  expect(screen.queryByTestId("composition-notice")).not.toBeInTheDocument();
});

test("a refusal that keeps an earlier composition says so above the source", async () => {
  server.use(
    http.get(declarationsUrl, () =>
      HttpResponse.json({
        ...declarations,
        batteries: [battery("acme", "active", 3)],
        rootRevision: 2,
        lastError: "acme: unknown trust rank",
        composition: {
          served: {
            kind: "previous",
            rootRevision: 1,
            composedAt: "2026-01-01T00:00:00.000Z",
            batteries: [{ name: "acme", status: "active", composed: true }],
          },
          refusal: {
            message: "acme: unknown trust rank",
            at: "2026-01-02T00:00:00.000Z",
            rootRevision: 2,
          },
        },
      }),
    ),
  );
  mount();
  const notice = await screen.findByTestId("composition-notice");
  expect(notice).toHaveTextContent("Revision 2 was refused");
  expect(notice).toHaveTextContent("stays enforced");
  expect(
    screen.queryByRole("link", { name: /not enforced/ }),
  ).not.toBeInTheDocument();
});

test("a refusal with no earlier composition says nothing is enforced", async () => {
  server.use(
    http.get(declarationsUrl, () =>
      HttpResponse.json({
        ...declarations,
        batteries: [battery("acme", "active", 3)],
        lastError: "acme: unknown trust rank",
        composition: {
          served: { kind: "root_only" },
          refusal: {
            message: "acme: unknown trust rank",
            at: "2026-01-02T00:00:00.000Z",
            rootRevision: 1,
          },
        },
      }),
    ),
  );
  mount();
  expect(await screen.findByTestId("composition-notice")).toHaveTextContent(
    "Nothing is enforced",
  );
});

test("the effective policy is fetched only once its view is selected", async () => {
  server.use(
    http.get(effectiveUrl, () => {
      effectiveRequests += 1;
      return HttpResponse.json({
        ...effective,
        rootRevision: 2,
        lastError: "acme: unknown trust rank",
        composition: {
          served: {
            kind: "previous",
            rootRevision: 1,
            composedAt: "2026-01-01T00:00:00.000Z",
            batteries: [],
          },
          refusal: {
            message: "acme: unknown trust rank",
            at: "2026-01-02T00:00:00.000Z",
            rootRevision: 2,
          },
        },
      });
    }),
  );
  mount();
  await screen.findByRole("textbox", {
    name: "Organization guardrails policy",
  });
  expect(
    screen.queryByRole("textbox", { name: "Effective guardrails policy" }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: "Effective" }));
  expect(lastUrl()).toBe("/openappa/policy?view=effective");
  expect(effectiveRequests).toBe(0);
  cleanup();

  mount("view=effective");
  expect(
    await screen.findByRole("textbox", { name: "Effective guardrails policy" }),
  ).toHaveValue(effective.content);
  expect(effectiveRequests).toBe(1);
  expect(screen.getByTestId("effective-policy-error")).toHaveTextContent(
    "acme: unknown trust rank",
  );
  expect(screen.getByTestId("effective-policy")).toHaveAttribute(
    "data-composition",
    "refused-serving-previous",
  );
  expect(screen.getByTestId("effective-policy-error")).toHaveTextContent(
    "Revision 2 was refused. The runtime still enforces this document, composed from revision 1.",
  );
  expect(screen.getByText("Still enforced: revision 1")).toBeVisible();
  expect(
    screen.getByRole("textbox", { name: "Effective guardrails policy" }),
  ).toHaveAttribute("readonly");
});

test("the composed view names the batteries that fold in as empty stubs", async () => {
  server.use(
    http.get(declarationsUrl, () =>
      HttpResponse.json({
        ...declarations,
        batteries: [
          battery("acme", "active", 3),
          battery("globex", "missing_credentials", 5),
          battery("initech", "server_missing", 7),
          // An organization-wide battery composes though no rule routes to it.
          battery("hooli", "unrouted", 9, true),
        ],
      }),
    ),
  );
  mount("view=effective");
  const stubs = await screen.findByTestId("effective-policy-stubs");
  expect(stubs).toHaveTextContent("globex");
  expect(stubs).toHaveTextContent("initech");
  expect(stubs).not.toHaveTextContent("acme");
  expect(stubs).not.toHaveTextContent("hooli");
});

test("the composed view lists no stub while every battery is active", async () => {
  server.use(
    http.get(declarationsUrl, () =>
      HttpResponse.json({
        ...declarations,
        batteries: [battery("acme", "active", 3)],
      }),
    ),
  );
  mount("view=effective");
  await screen.findByRole("textbox", { name: "Effective guardrails policy" });
  expect(
    screen.queryByTestId("effective-policy-stubs"),
  ).not.toBeInTheDocument();
});

test("the files and the rule outline show only in the Source view", async () => {
  mount();
  expect(
    await screen.findByRole("textbox", {
      name: "Organization guardrails policy",
    }),
  ).toHaveAttribute("readonly");
  // A revision label beside a read-only source reads as unsaved edits.
  expect(screen.queryByText(/^Revision \d+$/)).not.toBeInTheDocument();
  expect(screen.queryByText("Not yet saved")).not.toBeInTheDocument();
  expect(screen.getAllByRole("tablist")).toHaveLength(1);
  expect(
    screen.getByRole("navigation", { name: "Policy files" }),
  ).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Hide files" }));
  expect(
    screen.queryByRole("navigation", { name: "Policy files" }),
  ).not.toBeInTheDocument();
  cleanup();

  // The choice is remembered for the next visit.
  mount();
  await screen.findByRole("textbox", {
    name: "Organization guardrails policy",
  });
  await userEvent.click(
    await screen.findByRole("button", { name: "Show files" }),
  );
  expect(
    screen.getByRole("navigation", { name: "Policy files" }),
  ).toBeVisible();
  cleanup();

  mount("view=effective");
  await screen.findByRole("textbox", { name: "Effective guardrails policy" });
  expect(
    screen.queryByRole("navigation", { name: "Policy files" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("complementary", { name: "Rule outline" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText("What the runtime enforces, batteries included."),
  ).toBeVisible();
});

test("a member with no Guardrails permission sees only their MCP servers' rules files, and which they may change", async () => {
  const payments = "mcp/payments_api.toml";
  const helpdesk = "mcp/helpdesk.toml";
  const text = "[policy]\nversion = 2\n";
  let organizationReads = 0;
  const refuse = () => {
    organizationReads += 1;
    return HttpResponse.json(
      { error: { message: "Forbidden" } },
      { status: 403 },
    );
  };
  server.use(
    http.get(`${origin}/api/user/permissions`, () =>
      HttpResponse.json(
        makeUserPermissions({
          guardrailsPolicy: [],
          organizationSettings: [],
          log: [],
        }),
      ),
    ),
    http.get(declarationsUrl, refuse),
    http.get(effectiveUrl, refuse),
    http.get(url, refuse),
    http.get(`${origin}/api/openappa/battery-policy-source`, refuse),
    http.get(`${origin}/api/openappa/server-rules/files`, () =>
      HttpResponse.json({
        files: [
          {
            path: payments,
            servers: [{ id: "payments", name: "payments_api" }],
            canEdit: true,
          },
          {
            path: helpdesk,
            servers: [{ id: "helpdesk", name: "helpdesk" }],
            canEdit: false,
          },
        ],
      }),
    ),
    http.get(`${origin}/api/openappa/server-rules/source`, ({ request }) => {
      const entry = new URL(request.url).searchParams.get("entry") ?? "";
      return HttpResponse.json({
        entry,
        name: entry,
        kind: "repository",
        content: `# ${entry}\n${text}`,
      });
    }),
  );
  mount();

  // The first file opens: there is no organization policy to land on.
  expect(
    await screen.findByRole("textbox", { name: `${payments} TOML` }),
  ).toHaveValue(`# ${payments}\n${text}`);
  const explorer = screen.getByRole("navigation", { name: "Policy files" });
  expect(within(explorer).getByText("MCP server rules")).toBeVisible();
  expect(
    within(explorer).queryByText("Organization policy"),
  ).not.toBeInTheDocument();
  expect(within(explorer).queryByText("Batteries")).not.toBeInTheDocument();
  expect(
    within(explorer).getByRole("button", { name: "payments_api.toml" }),
  ).toBeVisible();
  // The composed policy is the organization's.
  expect(
    screen.queryByRole("tab", { name: "Effective" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Edit Guardrails" })).toHaveAttribute(
    "href",
    "/chat?server=payments",
  );
  await userEvent.click(
    within(explorer).getByRole("button", { name: /^helpdesk\.toml/ }),
  );
  expect(lastUrl()).toBe(`/openappa/policy?${entryQuery(helpdesk)}`);
  cleanup();

  // A file they may read and not change says what changing it takes; a
  // link to the composed view stays on the source.
  mount(`${entryQuery(helpdesk)}&view=effective`);
  expect(
    await screen.findByRole("textbox", { name: `${helpdesk} TOML` }),
  ).toBeVisible();
  expect(
    await screen.findByRole("img", {
      name: "Read-only. Changing these rules takes edit access to helpdesk in the MCP registry.",
    }),
  ).toBeVisible();
  expect(
    screen.queryByRole("link", { name: "Edit Guardrails" }),
  ).not.toBeInTheDocument();
  expect(organizationReads).toBe(0);
});
