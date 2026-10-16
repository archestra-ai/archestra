import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
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
import { appaGithubSyncQueryKey } from "@/lib/openappa-policy-views";
import { OverviewSetupCards } from "./overview-setup-cards";

vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");
const api = "http://localhost:9000/api";
const server = setupServer(
  http.get("http://localhost:9000/api/agents/chat-roster", () =>
    HttpResponse.json([
      {
        id: "appa-agent",
        name: "OpenAPPA Configuration Agent",
        scope: "org",
        builtIn: true,
        builtInAgentConfig: { name: "openappa-configuration-agent" },
        authorId: null,
        labels: [],
      },
    ]),
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
        <OverviewSetupCards />
      </QueryClientProvider>,
    ),
  };
}
test("a fresh instance shows only the policy step", async () => {
  show();
  expect(
    await screen.findByRole("heading", { name: "Turn on the guardrail" }),
  ).toBeInTheDocument();
  expect(
    await screen.findByRole("link", { name: "Create my policy" }),
  ).toHaveAttribute(
    "href",
    expect.stringContaining("/chat?agentId=appa-agent&user_prompt="),
  );
  expect(
    screen.getByText(/frontier deterministic guardrail/),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: /How OpenAPPA works/ }),
  ).toHaveAttribute("href", "https://www.openappa.com/how-it-works");
  expect(screen.queryByText("Connect GitHub")).not.toBeInTheDocument();
});

test("members who cannot edit the policy are told who can", async () => {
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
    await screen.findByText("Ask an administrator to turn on the guardrail."),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Create my policy" }),
  ).not.toBeInTheDocument();
});

test("a saved policy with healthy sync shows nothing here", async () => {
  revision = 1;
  enabled = true;
  sync = { ...sync, hasPolicy: true, source };
  const { client, container } = show();
  await waitFor(() =>
    expect(client.getQueryState(appaGithubSyncQueryKey)?.status).toBe(
      "success",
    ),
  );
  expect(container).toBeEmptyDOMElement();
});

test("a failed sync shows its error", async () => {
  revision = 1;
  enabled = true;
  sync = {
    ...sync,
    hasPolicy: true,
    source: { ...source, lastSyncError: "appa.toml was not found" },
  };
  show();
  expect(await screen.findByText("Git sync failed")).toBeVisible();
  expect(
    within(screen.getByRole("alert")).getByRole("link", {
      name: "Review sync settings",
    }),
  ).toHaveAttribute("href", "/settings/guardrails");
});

test("shows the initial merge link on Overview while sync waits for setup", async () => {
  revision = 1;
  enabled = true;
  sync = {
    ...sync,
    githubWebUrl: "https://github.example.com",
    provider: "github",
    source: { ...source, setupPullRequestNumber: 7, sourceCommit: null },
  };
  show();
  expect(await screen.findByText("Merge your initial policy")).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Review and merge PR" }),
  ).toHaveAttribute(
    "href",
    "https://github.example.com/example/policies/pull/7",
  );
  expect(
    screen.getByText(/Your current policy stays active until it merges/),
  ).toBeVisible();
});
