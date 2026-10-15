import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import type { PolicyTestRun } from "@/lib/openappa-policy-tests.query";
import { formatDate } from "@/lib/utils/date-time";
import { OverviewStatusCards } from "./overview-status-cards";

vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");
const api = "http://localhost:9000/api";
const server = setupServer(
  http.get("http://localhost:9000/api/agents", () =>
    HttpResponse.json({
      data: [
        {
          id: "appa-agent",
          name: "OpenAPPA Configuration Agent",
          scope: "org",
          builtIn: true,
          builtInAgentConfig: { name: "openappa-configuration-agent" },
          authorId: null,
          labels: [],
        },
      ],
    }),
  ),
);
let enabled: boolean;
let revision: number;
let sync: archestraApiTypes.GetAppaGithubSyncResponses["200"];
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
  lastSyncedAt: "2026-09-15T12:00:00Z",
  lastSyncError: null,
  setupPullRequestNumber: null,
  declarationsPendingPublish: false,
  heldContentHash: null,
  heldSourceCommit: null,
  heldReasons: [],
};
const validationRun: PolicyTestRun = {
  id: "latest-run",
  createdAt: "2026-10-06T12:00:00Z",
  createdBy: null,
  source: "github",
  sourceVersion: "tests-v1",
  sourceCommit: source.sourceCommit,
  definitionHash: "definitions-v1",
  policyRevision: 1,
  policyHash: "policy-v1",
  effectivePolicyHash: "effective-v1",
  engineVersion: "engine-v1",
  draft: false,
  stale: false,
  trigger: "github_sync",
  validation: { valid: true, errors: [], warnings: [] },
  files: ["passed", "failed", "cannot_run"].map((status, index) => ({
    path: `scenario-${index}.appa`,
    contentHash: `content-${index}`,
    assertionCount: 1,
    status: status as "passed" | "failed" | "cannot_run",
    steps: [],
  })),
};
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  enabled = false;
  revision = 0;
  sync = {
    validationDirectory: "",
    enabled: true,
    hasPolicy: false,
    githubWebUrl: "https://github.com",
    provider: "github",
    source: null,
  };
  server.use(
    http.get(`${api}/guardrails-deployment`, () =>
      HttpResponse.json({
        enabled,
        featureEnabled: true,
        active: enabled,
        unsupportedClientAction: "bypass",
      }),
    ),
    http.get(`${api}/guardrails-policy`, () =>
      HttpResponse.json({
        organizationId: "org",
        revision,
        content: "",
        contentHash: "hash",
        updatedBy: null,
        updatedAt: null,
      }),
    ),
    http.get(`${api}/openappa/github-sync`, () => HttpResponse.json(sync)),
    http.get(`${api}/credentials`, () => HttpResponse.json([])),
    http.get(`${api}/openappa/github-app/pending`, () =>
      HttpResponse.json(null),
    ),
    http.get(`${api}/openappa/yells/summary`, () =>
      HttpResponse.json({ unresolved: 0, superyells: 0 }),
    ),
    http.get(`${api}/openappa/policy-tests/runs`, () => HttpResponse.json([])),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <OverviewStatusCards />
      </QueryClientProvider>,
    ),
  };
}
/** The status badge, not the chart legend that shares its words. */
const statusBadge = { selector: '[data-slot="badge"] > span' };

test("the dashboard summarizes the latest run time and validation count with a direct link", async () => {
  revision = 1;
  server.use(
    http.get(`${api}/openappa/policy-tests/runs`, () =>
      HttpResponse.json([
        validationRun,
        { ...validationRun, id: "older", files: [] },
      ]),
    ),
  );
  show();
  const summary = await screen.findByRole("region", {
    name: "Last validation run",
  });
  expect(summary).not.toHaveTextContent("1 passed");
  expect(summary).not.toHaveTextContent("1 failed");
  expect(summary).not.toHaveTextContent("1 cannot run");
  expect(summary).toHaveTextContent(
    `Last run ${formatDate({ date: validationRun.createdAt })}`,
  );
  expect(
    within(summary).getByRole("img", {
      name: "Validation results over the last 2 runs",
    }),
  ).toBeVisible();
  expect(summary).not.toHaveTextContent("Git sync run");
  expect(screen.getByText("Failed", statusBadge)).toBeVisible();
  expect(
    screen.getByRole("link", { name: "View Validations" }),
  ).toHaveAttribute("href", "/openappa/validation");
});

test.each([
  {
    name: "all passing",
    run: { ...validationRun, files: [validationRun.files[0]] },
    status: "Passed",
  },
  {
    name: "incomplete",
    run: { ...validationRun, files: [validationRun.files[2]] },
    status: "Cannot run",
  },
  { name: "empty", run: { ...validationRun, files: [] }, status: "Cannot run" },
  {
    name: "invalid policy",
    run: {
      ...validationRun,
      validation: {
        valid: false,
        errors: ["Invalid configuration"],
        warnings: [],
      },
    },
    status: "Cannot run",
  },
])("the dashboard reports $name runs accurately", async ({ run, status }) => {
  revision = 1;
  server.use(
    http.get(`${api}/openappa/policy-tests/runs`, () =>
      HttpResponse.json([run]),
    ),
  );
  show();
  expect(await screen.findByText(status, statusBadge)).toBeVisible();
});

test("draft and stale results are visibly qualified", async () => {
  revision = 1;
  server.use(
    http.get(`${api}/openappa/policy-tests/runs`, () =>
      HttpResponse.json([{ ...validationRun, draft: true, stale: true }]),
    ),
  );
  show();
  const summary = await screen.findByRole("region", {
    name: "Last validation run",
  });
  expect(await screen.findByText("Failed (draft)")).toBeVisible();
  expect(screen.queryByText(/outdated/)).not.toBeInTheDocument();
  expect(summary).toHaveTextContent(
    formatDate({ date: validationRun.createdAt }),
  );
  expect(summary).not.toHaveTextContent("Draft run");
});

test("unavailable runs show cannot run without detailed errors or invented counts", async () => {
  revision = 1;
  server.use(
    http.get(`${api}/openappa/policy-tests/runs`, () =>
      HttpResponse.json([
        {
          ...validationRun,
          executionError: "GitHub denied access to validation files",
          files: [],
        },
      ]),
    ),
  );
  show();
  const summary = await screen.findByRole("region", {
    name: "Last validation run",
  });
  expect(await screen.findByText("Cannot run", statusBadge)).toBeVisible();
  expect(summary).not.toHaveTextContent(
    "GitHub denied access to validation files",
  );
  expect(summary).not.toHaveTextContent("passed");
  expect(summary).toHaveTextContent("could not run");
});

test("no saved runs is distinguished from a history-loading failure", async () => {
  revision = 1;
  server.use(
    http.get(`${api}/openappa/policy-tests`, () =>
      HttpResponse.json({
        source: "local",
        files: [],
        version: "empty",
        sourceCommit: null,
        directory: "traces",
        activeDirectory: "traces",
        error: null,
      }),
    ),
  );
  show();
  expect(await screen.findByText("No validations yet")).toBeVisible();
  expect(screen.getByText("Write a validation")).toBeVisible();
  expect(screen.queryByText("Passed", statusBadge)).not.toBeInTheDocument();
});

test("failed history loading is retryable rather than presented as empty or passing", async () => {
  revision = 1;
  let unavailable = true;
  server.use(
    http.get(`${api}/openappa/policy-tests/runs`, () =>
      unavailable
        ? new HttpResponse(null, { status: 503 })
        : HttpResponse.json([validationRun]),
    ),
  );
  show();
  expect(await screen.findByText("Could not load validation")).toBeVisible();
  expect(screen.queryByText("No validations yet")).not.toBeInTheDocument();
  expect(screen.queryByText("Passed", statusBadge)).not.toBeInTheDocument();
  unavailable = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Failed", statusBadge)).toBeVisible();
});

test("the dashboard adopts a newer result when history refreshes", async () => {
  revision = 1;
  let latest = validationRun;
  server.use(
    http.get(`${api}/openappa/policy-tests/runs`, () =>
      HttpResponse.json([latest]),
    ),
  );
  const { client } = show();
  await screen.findByRole("region", { name: "Last validation run" });
  latest = { ...validationRun, id: "newer", files: [validationRun.files[0]] };
  await act(() =>
    client.invalidateQueries({ queryKey: ["openappa-policy-test-runs"] }),
  );
  await waitFor(() => {
    expect(screen.getByText("Passed", statusBadge)).toBeVisible();
    expect(screen.queryByText("Failed", statusBadge)).not.toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Validation results over the last 1 run",
      }),
    ).toBeVisible();
  });
});

test("an unconnected sync offers to create a repository", async () => {
  show();
  expect(
    await screen.findByRole("button", { name: "Create repository" }),
  ).toBeVisible();
  expect(screen.getByText("Not connected")).toBeVisible();
});

test("members who cannot manage sync are told who can connect it", async () => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data: Object.values(permissions).every((actions) =>
          actions.every((action) => action === "read"),
        ),
      }) as ReturnType<typeof useHasPermissions>,
  );
  show();
  expect(
    await screen.findByText("Ask an administrator to connect a repository."),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Create repository" }),
  ).not.toBeInTheDocument();
});

test("a failed sync says so and links to the sync settings", async () => {
  sync = {
    ...sync,
    hasPolicy: true,
    source: { ...source, lastSyncError: "appa.toml was not found" },
  };
  show();
  expect(await screen.findByText("Sync failed")).toBeVisible();
  expect(screen.getByRole("link", { name: "example/policies" })).toBeVisible();
  expect(screen.getByRole("link", { name: /Sync settings/ })).toHaveAttribute(
    "href",
    "/settings/guardrails",
  );
});

test("shows the initial merge link while sync waits for setup", async () => {
  sync = {
    ...sync,
    source: { ...source, setupPullRequestNumber: 7, sourceCommit: null },
  };
  show();
  expect(await screen.findByText("Awaiting initial merge")).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Review and merge PR" }),
  ).toHaveAttribute("href", "https://github.com/example/policies/pull/7");
  expect(
    screen.getByText(/Your current policy stays active until it merges/),
  ).toBeVisible();
});

test("a connected sync links to its repository", async () => {
  sync = { ...sync, hasPolicy: true, source };
  show();
  expect(await screen.findByText("Connected")).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "example/policies" }),
  ).toHaveAttribute("href", "https://github.com/example/policies");
  expect(screen.getByRole("link", { name: /Sync settings/ })).toHaveAttribute(
    "href",
    "/settings/guardrails",
  );
});
