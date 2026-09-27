import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));
vi.mock("sonner");
const api = "http://localhost:9000/api";
const server = setupServer(
  http.get("http://localhost:9000/api/agents/all", () =>
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
  return render(
    <QueryClientProvider client={client}>
      <OverviewSetupCards />
    </QueryClientProvider>,
  );
}
test("a fresh instance shows only the policy step", async () => {
  show();
  expect(await screen.findByText("Turn on the guardrail")).toBeInTheDocument();
  expect(
    await screen.findByRole("link", { name: "Create my policy" }),
  ).toHaveAttribute(
    "href",
    expect.stringContaining("/chat?agentId=appa-agent&user_prompt="),
  );
  expect(
    screen.getByText(/Archestra's guardrail uses OpenAPPA/),
  ).toBeInTheDocument();
  expect(
    screen.getByText("You review it. Nothing changes until you approve."),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: /How OpenAPPA works/ }),
  ).toHaveAttribute("href", "https://www.openappa.com/how-it-works");
  expect(screen.queryByText("Connect GitHub")).not.toBeInTheDocument();
});

test("members who cannot edit the policy are told who can", async () => {
  vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
    typeof useHasPermissions
  >);
  show();
  expect(
    await screen.findByText("Ask an administrator to turn on the guardrail."),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Create my policy" }),
  ).not.toBeInTheDocument();
});

function nextStep(container: HTMLElement) {
  return container.querySelector("[data-next-step]");
}

test("a saved policy with enforcement off makes enforcement the next step", async () => {
  revision = 3;
  const { container } = show();
  const toggle = await screen.findByRole("switch", {
    name: "Enforce the policy",
  });
  expect(toggle).not.toBeChecked();
  expect(toggle).toBeEnabled();
  expect(nextStep(container)).toHaveTextContent("Enforcement");
  expect(
    screen.queryByRole("link", { name: "Ask about the policy" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("How it works")).toBeInTheDocument();
  expect(screen.queryByText("Turn on the guardrail")).not.toBeInTheDocument();
});

test("the enforcement switch turns enforcement on and off", async () => {
  revision = 3;
  const sent: boolean[] = [];
  server.use(
    http.put(`${api}/guardrails-deployment`, async ({ request }) => {
      const body = (await request.json()) as { enabled: boolean };
      sent.push(body.enabled);
      enabled = body.enabled;
      return HttpResponse.json({
        enabled,
        featureEnabled: true,
        active: enabled,
      });
    }),
  );
  show();
  const toggle = await screen.findByRole("switch", {
    name: "Enforce the policy",
  });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(await screen.findByText("On")).toBeInTheDocument();
  await waitFor(() => expect(toggle).toBeEnabled());
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(sent).toEqual([true, false]);
});

test("members who cannot manage enforcement see the switch disabled", async () => {
  revision = 3;
  vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
    typeof useHasPermissions
  >);
  show();
  expect(
    await screen.findByRole("switch", { name: "Enforce the policy" }),
  ).toBeDisabled();
  expect(
    screen.getByText(/Only administrators can turn enforcement on or off/),
  ).toBeInTheDocument();
});

test("an enforced policy makes GitHub step 2 of 2", async () => {
  revision = 1;
  enabled = true;
  const { container } = show();
  const connect = await screen.findByRole("button", {
    name: "Connect GitHub",
  });
  expect(screen.getByText("Step 2 of 2")).toBeInTheDocument();
  expect(nextStep(container)).toHaveTextContent("GitHub sync");
  expect(screen.getByText("On")).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Ask about the policy" }),
  ).toHaveAttribute(
    "href",
    expect.stringContaining("/chat?agentId=appa-agent&user_prompt="),
  );
  expect(
    screen.getByRole("switch", { name: "Enforce the policy" }),
  ).toBeChecked();
  expect(
    screen.getByRole("link", { name: /Read about OpenAPPA/ }),
  ).toHaveAttribute("href", "https://www.openappa.com/how-it-works");
  fireEvent.click(connect);
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(screen.getByText("Copy current policy")).toBeInTheDocument();
});

test("members who cannot manage sync are told who can connect it", async () => {
  revision = 1;
  enabled = true;
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

test("a failed sync shows its error", async () => {
  revision = 1;
  enabled = true;
  sync = {
    enabled: true,
    hasPolicy: true,
    source: { ...source, lastSyncError: "appa.toml was not found" },
  };
  show();
  expect(
    await screen.findByText("appa.toml was not found"),
  ).toBeInTheDocument();
  expect(screen.getByText("Sync failed")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Edit connection" }),
  ).toBeInTheDocument();
});

test("once sync is connected the cards stay as status with no next step", async () => {
  revision = 1;
  enabled = true;
  sync = { enabled: true, hasPolicy: true, source };
  const { container } = show();
  expect(await screen.findByText("Connected")).toBeInTheDocument();
  expect(screen.getByText("example/policies")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Sync settings/ })).toHaveAttribute(
    "href",
    "/settings/openappa",
  );
  expect(nextStep(container)).toBeNull();
  expect(screen.queryByText("Step 2 of 2")).not.toBeInTheDocument();
});
