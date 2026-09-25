import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useRouter } from "next/navigation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { invalidatePolicyViews } from "@/lib/openappa-policy-views";
import { GuardrailsPolicyEditor } from "./guardrails-policy-editor";

vi.mock("@/components/editor");
vi.mock("next/navigation");
vi.mock("sonner");
const mockRouterPush = vi.fn();
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
const declarations = {
  batteries: [],
  unusedAliases: [],
  rootRevision: 1,
  lastError: null,
  managedInGithub: false,
  heldPull: null,
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
};
let effectiveRequests = 0;
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  vi.mocked(useRouter).mockReturnValue({
    push: mockRouterPush,
  } as unknown as ReturnType<typeof useRouter>);
  mockRouterPush.mockClear();
  effectiveRequests = 0;
  server.use(
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
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function mount(sourceEntry?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <GuardrailsPolicyEditor sourceEntry={sourceEntry} />
    </QueryClientProvider>,
  );
  return client;
}

test("the Policy page selects an included battery source and searches its status", async () => {
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
  mount(githubEntry);

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

  await userEvent.click(
    screen.getByRole("combobox", { name: "Policy source file" }),
  );
  await userEvent.type(
    await screen.findByPlaceholderText("Search included batteries"),
    "active",
  );
  expect(screen.getByRole("option", { name: /GitHubActive/ })).toBeVisible();
  expect(
    screen.queryByRole("option", { name: /pendingNeeds a credential/ }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("option", { name: "Organization policy" }),
  );
  expect(mockRouterPush).toHaveBeenCalledWith("/openappa/policy");
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
  mount(entry);
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
  const client = mount(entry);
  const source = await screen.findByRole("textbox", {
    name: "GitHub battery policy TOML",
  });
  expect(source).toHaveValue(batteryContent);
  batteryContent = 'name = "mcp/github/get_issue"';
  await invalidatePolicyViews(client);
  await waitFor(() => expect(source).toHaveValue(batteryContent));
});

test("a GitHub-synced policy says where it comes from", async () => {
  server.use(
    http.get(`${origin}/api/openappa/github-sync`, () =>
      HttpResponse.json({
        enabled: true,
        source: { interval: "1h" },
        hasPolicy: true,
      }),
    ),
  );
  mount();
  expect(await screen.findByText("Synced from GitHub")).toBeVisible();
});

test("the editor footer counts the composed batteries and the unenforced ones", async () => {
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
  const summary = await screen.findByTestId("composition-summary");
  await waitFor(() => expect(summary).toHaveAttribute("data-batteries", "3"));
  expect(summary).toHaveAttribute("data-not-enforced", "1");
  expect(summary).not.toHaveAttribute("data-failed");
  expect(
    within(summary).getByRole("link", { name: "1 not enforced" }),
  ).toHaveAttribute("href", "/openappa/batteries?status=broken");
});

test("a failed composition says so instead of counting batteries", async () => {
  server.use(
    http.get(declarationsUrl, () =>
      HttpResponse.json({
        ...declarations,
        batteries: [battery("acme", "active", 3)],
        lastError: "acme: unknown trust rank",
      }),
    ),
  );
  mount();
  const summary = await screen.findByTestId("composition-summary");
  await waitFor(() => expect(summary).toHaveAttribute("data-failed", "true"));
  expect(summary).not.toHaveAttribute("data-batteries");
});

test("the effective policy is fetched only once its view is selected", async () => {
  server.use(
    http.get(effectiveUrl, () => {
      effectiveRequests += 1;
      return HttpResponse.json({
        ...effective,
        lastError: "acme: unknown trust rank",
      });
    }),
  );
  mount();
  await screen.findByRole("textbox", {
    name: "Organization guardrails policy",
  });
  expect(effectiveRequests).toBe(0);
  expect(
    screen.queryByRole("textbox", { name: "Effective guardrails policy" }),
  ).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: "Effective" }));
  expect(
    await screen.findByRole("textbox", { name: "Effective guardrails policy" }),
  ).toHaveValue(effective.content);
  expect(effectiveRequests).toBe(1);
  expect(screen.getByTestId("effective-policy-error")).toHaveTextContent(
    "acme: unknown trust rank",
  );
  expect(screen.getByTestId("effective-policy")).toHaveAttribute(
    "data-refused",
    "true",
  );
  expect(screen.getByText("Last composed policy")).toBeVisible();
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
  mount();
  await userEvent.click(await screen.findByRole("tab", { name: "Effective" }));
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
  mount();
  await userEvent.click(await screen.findByRole("tab", { name: "Effective" }));
  await screen.findByRole("textbox", { name: "Effective guardrails policy" });
  expect(
    screen.queryByTestId("effective-policy-stubs"),
  ).not.toBeInTheDocument();
});

test("the source picker and revision show only in the Source view", async () => {
  mount();
  expect(await screen.findByText("Revision 1")).toBeVisible();
  expect(
    screen.getByRole("textbox", { name: "Organization guardrails policy" }),
  ).toHaveAttribute("readonly");
  expect(screen.getAllByRole("tablist")).toHaveLength(1);
  expect(
    screen.getByRole("combobox", { name: "Policy source file" }),
  ).toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: "Effective" }));
  await screen.findByRole("textbox", { name: "Effective guardrails policy" });
  expect(
    screen.queryByRole("combobox", { name: "Policy source file" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Revision 1")).not.toBeInTheDocument();
  expect(
    screen.getByText("What the runtime enforces, batteries included."),
  ).toBeVisible();
});
