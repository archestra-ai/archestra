import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { authQueryKeys } from "@/lib/auth/auth.query";
import { GuardrailsPolicyEditor } from "./guardrails-policy-editor";

vi.mock("@/components/editor");
vi.mock("sonner");
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
function battery(name: string, status: string, line: number) {
  return {
    entry: `${name}/policy.toml`,
    name,
    source: "bundled",
    packageHash: null,
    status,
    line,
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
    http.get(`${origin}/api/user/permissions`, () =>
      HttpResponse.json({ toolPolicy: ["read", "update"] }),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(authQueryKeys.session(), {
    user: { id: "user" },
    session: { id: "session" },
  });
  render(
    <QueryClientProvider client={client}>
      <GuardrailsPolicyEditor />
    </QueryClientProvider>,
  );
  return client;
}

test("validates edits inline, saves the exact text and revision, and becomes clean", async () => {
  let submitted: unknown;
  server.use(
    http.post(`${url}/validate`, () =>
      HttpResponse.json({
        valid: false,
        errors: ["Unknown trust rank"],
        warnings: [],
      }),
    ),
    http.put(url, async ({ request }) => {
      submitted = await request.json();
      return HttpResponse.json({
        ...policy,
        content: `${content}# edited`,
        revision: 2,
      });
    }),
  );
  mount();
  const editor = await screen.findByRole("textbox", {
    name: "Organization guardrails policy",
  });
  await screen.findByRole("button", { name: "Validate" });
  fireEvent.change(editor, { target: { value: `${content}# edited` } });
  fireEvent.click(screen.getByRole("button", { name: "Validate" }));
  expect(await screen.findByText("Unknown trust rank")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save & apply" }));
  await screen.findByText("Revision 2");
  expect(submitted).toEqual({
    content: `${content}# edited`,
    expectedRevision: 1,
  });
  expect(screen.getByRole("button", { name: "Save & apply" })).toBeDisabled();
});

test("preserves local edits when another writer updates the policy and rejects a stale save", async () => {
  server.use(
    http.put(url, () =>
      HttpResponse.json(
        {
          error: {
            message: "Policy changed; reload before saving",
            type: "conflict",
          },
        },
        { status: 409 },
      ),
    ),
  );
  const client = mount();
  const editor = await screen.findByRole("textbox", {
    name: "Organization guardrails policy",
  });
  await screen.findByRole("button", { name: "Save & apply" });
  fireEvent.change(editor, { target: { value: `${content}# my change` } });
  client.setQueryData(["guardrails-policy"], {
    ...policy,
    revision: 2,
    content: `${content}# other change`,
  });
  await screen.findByText(/A newer revision is available/);
  expect(editor).toHaveValue(`${content}# my change`);
  fireEvent.click(screen.getByRole("button", { name: "Save & apply" }));
  expect(
    await screen.findByText("Policy changed; reload before saving"),
  ).toBeInTheDocument();
  expect(editor).toHaveValue(`${content}# my change`);
});

test("read-only users can inspect the policy without editing controls", async () => {
  server.use(
    http.get(`${origin}/api/user/permissions`, () =>
      HttpResponse.json({ toolPolicy: ["read"] }),
    ),
  );
  mount();
  const editor = await screen.findByRole("textbox", {
    name: "Organization guardrails policy",
  });
  await waitFor(() => expect(editor).toHaveAttribute("readonly"));
  expect(
    screen.queryByRole("button", { name: "Save & apply" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Validate" }),
  ).not.toBeInTheDocument();
});

test("GitHub-owned policy is read-only and becomes editable after disconnect", async () => {
  server.use(
    http.get(`${origin}/api/openappa/github-sync`, () =>
      HttpResponse.json({
        enabled: true,
        source: { interval: "1h" },
        hasPolicy: true,
      }),
    ),
  );
  const client = mount();
  expect(await screen.findByText("Synced from GitHub")).toBeVisible();
  expect(
    screen.getByRole("textbox", { name: "Organization guardrails policy" }),
  ).toHaveAttribute("readonly");
  expect(
    screen.queryByRole("button", { name: "Save & apply" }),
  ).not.toBeInTheDocument();
  server.use(
    http.get(`${origin}/api/openappa/github-sync`, () =>
      HttpResponse.json({
        enabled: true,
        source: { interval: null },
        hasPolicy: true,
      }),
    ),
  );
  await client.invalidateQueries({ queryKey: ["openappa-github-sync"] });
  expect(
    await screen.findByRole("button", { name: "Save & apply" }),
  ).toBeVisible();
});

test("a validate that warns keeps the warnings apart from the errors", async () => {
  server.use(
    http.post(`${url}/validate`, () =>
      HttpResponse.json({
        valid: false,
        errors: ["Unknown trust rank"],
        warnings: ['include "acme" resolves to no battery'],
      }),
    ),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Validate" }));
  const warnings = await screen.findByTestId("policy-warnings");
  expect(warnings).toHaveTextContent('include "acme" resolves to no battery');
  expect(warnings).not.toHaveTextContent("Unknown trust rank");
  expect(screen.getAllByRole("alert")).toHaveLength(2);
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

test("the effective policy is fetched only once its tab is opened", async () => {
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
  await screen.findByRole("button", { name: "Validate" });
  expect(effectiveRequests).toBe(0);
  expect(
    screen.queryByRole("textbox", { name: "Effective guardrails policy" }),
  ).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: "Effective policy" }));
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
  expect(
    screen.getByRole("textbox", { name: "Effective guardrails policy" }),
  ).toHaveAttribute("readonly");
});

test("switching to the composed view and back keeps an unsaved draft", async () => {
  mount();
  const editor = await screen.findByRole("textbox", {
    name: "Organization guardrails policy",
  });
  fireEvent.change(editor, { target: { value: `${content}# my draft` } });
  await userEvent.click(screen.getByRole("tab", { name: "Effective policy" }));
  await screen.findByRole("textbox", { name: "Effective guardrails policy" });
  await userEvent.click(screen.getByRole("tab", { name: "Policy" }));
  expect(
    await screen.findByRole("textbox", {
      name: "Organization guardrails policy",
    }),
  ).toHaveValue(`${content}# my draft`);
});
