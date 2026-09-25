import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
import { OverviewSetupCards } from "./overview-setup-cards";

vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");
const api = "http://localhost:9000/api";
const server = setupServer();
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
  githubAppConfigId: null,
  revision: "revision",
  sourceCommit: "a".repeat(40),
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
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  enabled = false;
  revision = 0;
  sync = { enabled: true, hasPolicy: false, source: null };
  server.use(
    http.get(`${api}/guardrails-deployment`, () =>
      HttpResponse.json({ enabled, featureEnabled: true, active: enabled }),
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
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <OverviewSetupCards />
    </QueryClientProvider>,
  );
}
function card(title: string) {
  return screen.getByText(title).closest("[data-slot=card]") as HTMLElement;
}

test("a fresh instance starts the first-policy chat and offers GitHub setup", async () => {
  show();
  expect(await screen.findByText("Off")).toBeInTheDocument();
  expect(
    within(card("Enforcement")).getByRole("link", {
      name: "Set up with chat",
    }),
  ).toHaveAttribute(
    "href",
    expect.stringMatching(
      /^\/chat\?openappa=1&openappaPrompt=setUpPolicy&from=openappa$/,
    ),
  );
  expect(await screen.findByText("Not connected")).toBeInTheDocument();
  expect(
    within(card("How it works")).getByRole("link", {
      name: /Read how it works/,
    }),
  ).toHaveAttribute("href", "https://www.openappa.com/how-it-works");
  fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
});

test("a saved policy with enforcement off starts a chat that reviews it", async () => {
  revision = 3;
  show();
  expect(
    await screen.findByText(/review your saved policy/),
  ).toBeInTheDocument();
  expect(
    within(card("Enforcement")).getByRole("link", {
      name: "Set up with chat",
    }),
  ).toHaveAttribute(
    "href",
    expect.stringMatching(
      /^\/chat\?openappa=1&openappaPrompt=resumePolicy&from=openappa$/,
    ),
  );
});

test("a configured instance shows both steps done", async () => {
  enabled = true;
  sync = { enabled: true, hasPolicy: true, source };
  show();
  expect(await screen.findByText("On")).toBeInTheDocument();
  expect(
    within(card("Enforcement")).getByRole("link", {
      name: "Configure with chat",
    }),
  ).toHaveAttribute(
    "href",
    expect.stringMatching(
      /^\/chat\?openappa=1&openappaPrompt=reviewPolicy&from=openappa$/,
    ),
  );
  expect(await screen.findByText("Connected")).toBeInTheDocument();
  expect(screen.getByText("example/policies")).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Open sync settings" }),
  ).toHaveAttribute("href", "/settings/openappa");
});

test("members who cannot manage sync are told who can connect it", async () => {
  vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
    typeof useHasPermissions
  >);
  show();
  expect(
    await screen.findByText("Ask an administrator to connect a repository."),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Connect GitHub" }),
  ).not.toBeInTheDocument();
});
