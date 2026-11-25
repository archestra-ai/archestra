import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
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
  getValidationSaveResult,
  isOpenAppaPreview,
  OpenAppaPolicyChange,
  OpenAppaPolicyCompletion,
  OpenAppaValidationCompletion,
} from "./openappa-policy-change";

vi.mock("@/lib/auth/auth.query");
const server = setupServer();
let sync: archestraApiTypes.GetAppaGithubSyncResponses["200"];
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  sync = {
    enabled: true,
    hasPolicy: true,
    validationDirectory: "",
    githubWebUrl: "https://github.com",
    provider: "github",
    selfService: {
      enabled: false,
      setting: false,
      directory: "mcp",
    },
    autoMerge: { enabled: false, setting: false },
    source: null,
  };
  server.use(
    http.get("http://localhost:9000/api/openappa/github-sync", () =>
      HttpResponse.json(sync),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function withQueries(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

test("shows a policy preview from the chat tool's text result", () => {
  render(
    <OpenAppaPolicyChange
      output={{
        content: JSON.stringify({
          stage: "preview",
          delivery: "revision",
          before: "[policy]\nversion = 2\n",
          after:
            '[policy]\nversion = 2\n[[policy.tool]]\nname = "example__search"\n',
        }),
      }}
    />,
  );

  expect(screen.getByLabelText("Policy diff")).toHaveTextContent(
    'Added: name = "example__search"',
  );
});

test("shows a reviewable policy diff and the pull request link", () => {
  render(
    <OpenAppaPolicyChange
      output={{
        structuredContent: {
          delivery: "pull_request",
          number: 17,
          url: "https://github.com/example/policies/pull/17",
          path: "guardrails/appa.toml",
          before: '[policy]\nversion = 2\nname = "old"\n',
          after: '[policy]\nversion = 2\nname = "new"\n',
        },
      }}
    />,
  );

  expect(
    screen.getByRole("link", { name: "Review pull request" }),
  ).toHaveAttribute("href", "https://github.com/example/policies/pull/17");
  expect(screen.getByLabelText("Policy diff")).toHaveTextContent(
    'Removed: name = "old"',
  );
  expect(screen.getByLabelText("Policy diff")).toHaveTextContent(
    'Added: name = "new"',
  );
});

test("shows only the changed hunks when the backend sends its diff, unchanged lines folded", () => {
  render(
    <OpenAppaPolicyChange
      output={{
        structuredContent: {
          stage: "preview",
          delivery: "revision",
          before: "a\nb\nc\nd\ne\nf\ng\nh\n",
          after: "a\nb\nc\nd\ne\nf\ng\nH\n",
          diff: "--- a/p\n+++ b/p\n@@ -5,4 +5,4 @@\n e\n f\n g\n-h\n+H\n",
        },
      }}
    />,
  );

  const diff = screen.getByLabelText("Policy diff");
  expect(diff).not.toHaveTextContent("@@");
  expect(diff).toHaveTextContent("Unchanged lines hidden");
  expect(diff).not.toHaveTextContent("organization.appa.toml");
  expect(diff).toHaveTextContent("Removed: h");
  expect(diff).toHaveTextContent("8Added: H");
});

test("shows a first preview of the starter with every line added", () => {
  render(
    <OpenAppaPolicyChange
      output={{
        structuredContent: {
          stage: "preview",
          delivery: "revision",
          before: "[policy]\nversion = 2\n",
          after: "[policy]\nversion = 2\n",
        },
      }}
    />,
  );

  const diff = screen.getByLabelText("Policy diff");
  expect(diff).toHaveTextContent("1Added: [policy]");
  expect(diff).toHaveTextContent("2Added: version = 2");
});

test("does not render yellow policy warning cards on the preview", () => {
  render(
    <OpenAppaPolicyChange
      output={{
        structuredContent: {
          stage: "preview",
          delivery: "revision",
          before: "[policy]\nversion = 2\n",
          after:
            '[policy]\nversion = 2\n[[policy.tool]]\nname = "calendar__create_event"\n',
          warnings: ['tool rule "calendar__create_event" names no known tool'],
        },
      }}
    />,
  );

  expect(screen.getByLabelText("Policy diff")).toHaveTextContent(
    'Added: name = "calendar__create_event"',
  );
  expect(screen.queryByText("Policy warning")).not.toBeInTheDocument();
});

test("confirmation-required results do not open a policy preview card", () => {
  const output = {
    structuredContent: {
      stage: "confirmation_required",
      valid: true,
      unknownTools: [
        {
          rule: "calendar__create_event",
          reason: "unknown_server",
          prefix: "calendar",
          closest: [],
        },
      ],
    },
  };
  expect(
    isOpenAppaPreview({
      shortName: "preview_guardrails_policy_change",
      output,
    }),
  ).toBe(false);
  const { container } = render(<OpenAppaPolicyChange output={output} />);
  expect(container).toBeEmptyDOMElement();
});

test("keeps a large replacement bounded in chat and counts changes beyond the preview", () => {
  const before = Array.from({ length: 9_000 }, (_, i) => `old rule ${i}`);
  const after = Array.from({ length: 9_000 }, (_, i) => `new rule ${i}`);
  render(
    <OpenAppaPolicyChange
      output={{
        structuredContent: {
          stage: "preview",
          delivery: "revision",
          before: before.join("\n"),
          after: after.join("\n"),
          diff: [
            "@@ -1,9000 +1,9000 @@",
            ...before.map((line) => `-${line}`),
            ...after.map((line) => `+${line}`),
          ].join("\n"),
        },
      }}
    />,
  );
  const preview = screen.getByRole("region", { name: "Diff preview" });
  expect(preview).toHaveTextContent("old rule 0");
  expect(preview).not.toHaveTextContent("old rule 8999");
  expect(preview).not.toHaveTextContent("new rule 8999");
  expect(screen.getByText("9,000 added")).toBeVisible();
  expect(screen.getByText("9,000 removed")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Review full diff" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /Show \d+ more lines/ }),
  ).not.toBeInTheDocument();
});

const saved = {
  delivery: "revision",
  revision: 1,
  before: "starter",
  after: "starter",
  enforcement: { enabled: true },
  effective: { error: null, batteries: [{ status: "active" }] },
};

test("confirmed publication offers a return action without opening the diff", () => {
  render(
    withQueries(
      <OpenAppaPolicyCompletion output={{ structuredContent: saved }} />,
    ),
  );
  expect(screen.getByText("Saved revision 1")).toBeInTheDocument();
  expect(screen.getByText(/enforcement on/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "View Guardrails" })).toHaveAttribute(
    "href",
    "/openappa",
  );
  expect(screen.queryByLabelText("Policy diff")).not.toBeInTheDocument();
});

test.each([
  { ...saved, enforcement: { enabled: false } },
  { ...saved, effective: { error: "Composition failed", batteries: [] } },
  {
    ...saved,
    effective: { error: null, batteries: [{ status: "missing_credentials" }] },
  },
  { ...saved, enforcement: undefined },
  { ...saved, effective: undefined },
])("saved but unconfirmed results do not claim active protection", (output) => {
  render(withQueries(<OpenAppaPolicyCompletion output={output} />));
  expect(screen.getByText("Saved revision 1")).toBeInTheDocument();
  expect(
    screen.queryByText(/Enforcement confirmed on/),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Check policy" })).toHaveAttribute(
    "href",
    "/openappa/policy",
  );
});

test.each([
  { ...saved, stage: "preview" },
  { ...saved, delivery: "pull_request", number: 4 },
  { ...saved, revision: 0 },
])("preview and pending PR do not appear as a saved local policy", (output) => {
  const { container } = render(
    withQueries(<OpenAppaPolicyCompletion output={output} />),
  );
  expect(container).toBeEmptyDOMElement();
});

test("published PR stays reviewable outside collapsed tool details", () => {
  render(
    withQueries(
      <OpenAppaPolicyCompletion
        output={{
          delivery: "pull_request",
          number: 17,
          url: "https://github.com/example/policies/pull/17",
          before: "old",
          after: "new",
        }}
      />,
    ),
  );
  expect(
    screen.getByRole("link", { name: "Review pull request" }),
  ).toHaveAttribute("href", "https://github.com/example/policies/pull/17");
  expect(screen.queryByText(/Saved revision/)).not.toBeInTheDocument();
});

test("a locally saved policy suggests Git sync to admins who have not set it up", async () => {
  render(
    withQueries(
      <OpenAppaPolicyCompletion output={{ structuredContent: saved }} />,
    ),
  );
  const link = await screen.findByRole("link", { name: "Set up Git sync" });
  expect(link).toHaveAttribute(
    "href",
    "/settings/guardrails?setup=github-sync",
  );
  // A new tab keeps the conversation in place.
  expect(link).toHaveAttribute("target", "_blank");
});

test.each([
  [
    "sync already has a repository",
    () => {
      sync = {
        ...sync,
        source: {
          organizationId: "org",
          repo: "example/policies",
          ref: "main",
          path: "appa.toml",
          interval: "1h",
          githubPatId: null,
          gitlabTokenId: null,
          githubAppConfigId: null,
          revision: "revision",
          sourceCommit: null,
          setupPullRequestNumber: null,
          lastSyncedAt: null,
          lastSyncError: null,
          selfService: false,
          selfServiceDirectory: "mcp",
          selfServiceAutoMerge: false,
        },
      };
    },
  ],
  [
    "sync is off on the server",
    () => {
      sync = { ...sync, enabled: false };
    },
  ],
  [
    "the user cannot manage settings",
    () => {
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
])("no Git sync tip when %s", async (_name, arrange) => {
  arrange();
  let requested = false;
  server.use(
    http.get("http://localhost:9000/api/openappa/github-sync", () => {
      requested = true;
      return HttpResponse.json(sync);
    }),
  );
  render(
    withQueries(
      <OpenAppaPolicyCompletion output={{ structuredContent: saved }} />,
    ),
  );
  await vi.waitFor(() => expect(requested).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(
    screen.queryByRole("link", { name: "Set up Git sync" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Saved revision 1")).toBeInTheDocument();
});

const validationPublication = {
  delivery: "revision",
  revision: 2,
  version: "specs-v2",
  policyChanged: false,
  validation: { valid: true, errors: [], warnings: [] },
};

function validationRun(
  statuses: string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    validation: { valid: true },
    files: statuses.map((status, index) => ({
      path: `traces/check-${index}.appa`,
      status,
      steps: [],
    })),
    ...overrides,
  };
}

test.each([
  {
    name: "one passed file",
    run: validationRun(["passed"]),
    tone: "success",
    detail: "passed",
    href: "/openappa/validation/file?path=traces%2Fcheck-0.appa",
  },
  {
    name: "several passed files",
    run: validationRun(["passed", "passed"]),
    tone: "success",
    detail: "2 of 2 passed",
    href: "/openappa/validation/file?path=traces%2Fcheck-0.appa",
  },
  {
    name: "one failed file",
    run: validationRun(["failed"]),
    tone: "warning",
    detail: "failed",
    href: "/openappa/validation/file?path=traces%2Fcheck-0.appa",
  },
  {
    name: "a failure among mixed results",
    run: validationRun(["passed", "failed", "cannot_run"]),
    tone: "warning",
    detail: "1 of 3 failed",
    href: "/openappa/validation/file?path=traces%2Fcheck-1.appa",
  },
  {
    name: "a file that cannot run after a passing file",
    run: validationRun(["passed", "cannot_run"]),
    tone: "warning",
    detail: "could not run",
    href: "/openappa/validation/file?path=traces%2Fcheck-1.appa",
  },
  {
    name: "a file that cannot run",
    run: validationRun(["cannot_run"]),
    tone: "warning",
    detail: "could not run",
    href: "/openappa/validation/file?path=traces%2Fcheck-0.appa",
  },
  {
    name: "an execution error",
    run: validationRun(["passed"], { executionError: "Replay failed" }),
    tone: "warning",
    detail: "could not run",
    href: "/openappa/validation/file?path=traces%2Fcheck-0.appa",
  },
  {
    name: "an invalid policy",
    run: validationRun(["passed"], { validation: { valid: false } }),
    tone: "warning",
    detail: "could not run",
    href: "/openappa/validation/file?path=traces%2Fcheck-0.appa",
  },
  {
    name: "a post-save run error with saved paths",
    run: null,
    extra: {
      runError:
        "Too many Guardrails policy tests are running. Retry in a few seconds.",
      savedPaths: ["traces/check-0.appa"],
    },
    tone: "warning",
    detail: "could not run",
    href: "/openappa/validation/file?path=traces%2Fcheck-0.appa",
  },
  {
    name: "a post-save run error without saved paths",
    run: null,
    extra: {
      runError: "Guardrails stopped this policy test because it ran too long.",
    },
    tone: "warning",
    detail: "could not run",
    href: "/openappa/validation",
  },
  {
    name: "a deletion-only save",
    run: null,
    tone: "success",
    detail: "saved",
    href: "/openappa/validation",
  },
  {
    name: "a legacy save without a run",
    run: undefined,
    tone: "success",
    detail: "not run yet",
    href: "/openappa/validation",
  },
])("shows $name in the saved-validation result", ({
  run,
  extra,
  tone,
  detail,
  href,
}) => {
  const output = {
    structuredContent: { ...validationPublication, ...extra, run },
  };
  expect(getValidationSaveResult(output)).toMatchObject({
    tone,
    detail,
    action: { href },
  });
  render(<OpenAppaValidationCompletion output={output} />);
  expect(screen.getByText("Saved validations")).toBeInTheDocument();
  expect(screen.getByText(`· ${detail} ·`)).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "View Validations" }),
  ).toHaveAttribute("href", href);
});

test("keeps a validation pull request reviewable in the completion card", () => {
  const output = {
    structuredContent: {
      ...validationPublication,
      delivery: "pull_request",
      number: 17,
      url: "https://github.com/example/policies/pull/17",
    },
  };
  expect(getValidationSaveResult(output)).toMatchObject({
    tone: "success",
    detail: "merge it to apply",
  });
  render(<OpenAppaValidationCompletion output={output} />);
  expect(
    screen.getByRole("link", { name: "Review pull request" }),
  ).toHaveAttribute("href", "https://github.com/example/policies/pull/17");
  expect(screen.getByText(/merge it to apply/)).toBeInTheDocument();
});
