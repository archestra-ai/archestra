import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { usePathname, useRouter } from "next/navigation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  type RuntimeCredentialDefinition,
  runtimeCredentialsQueryKey,
} from "@/lib/runtime-credentials.query";
import { ConnectionsSection } from "./connections-section";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
const origin = "http://localhost:9000";
const server = setupServer();
let client: QueryClient;
const replace = vi.fn();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
afterEach(() => {
  server.resetHandlers();
  client.clear();
});
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  archestraApiClient.setConfig({ baseUrl: origin });
  replace.mockClear();
  vi.mocked(useRouter).mockReturnValue({
    replace,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    push: vi.fn(),
    prefetch: vi.fn(),
    bfcacheId: "account-connections",
  });
  vi.mocked(usePathname).mockReturnValue("/account/connections");
  vi.mocked(useFeature).mockImplementation(
    (feature) => feature === "agentRuntime",
  );
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  server.use(
    http.get(`${origin}/api/agents/all`, () => HttpResponse.json([])),
    http.get(`${origin}/api/credentials`, () =>
      HttpResponse.json([
        {
          kind: "github_app_user",
          key: "github",
          name: "GitHub",
          description: "Repository access",
          icon: "logo:github",
          builtIn: true,
          allowPersonal: true,
          allowOrganization: false,
          personalConfigured: true,
          organizationConfigured: false,
        },
      ]),
    ),
  );
});

function renderPage() {
  return render(
    <QueryClientProvider client={client}>
      <ConnectionsSection />
    </QueryClientProvider>,
  );
}

describe("ConnectionsSection", () => {
  it("opens GitHub sign-in from the row action", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Replace GitHub" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Connect GitHub" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Connect GitHub" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("confirms before removing a personal connection", async () => {
    const user = userEvent.setup();
    let deleted = false;
    server.use(
      http.delete(`${origin}/api/credentials/github/personal`, () => {
        deleted = true;
        return HttpResponse.json({ deleted: true });
      }),
    );
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "More actions GitHub" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Agent Runtime runs you start will no longer be able to use this connection.",
    );
    expect(deleted).toBe(false);
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(deleted).toBe(true));
    expect(screen.queryByText("Claude Code")).not.toBeInTheDocument();
  });

  it("shows one shared account for multiple installed Claude Agents and opens native sign-in", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${origin}/api/credentials`, () => HttpResponse.json([])),
      http.get(`${origin}/api/agents/all`, () =>
        HttpResponse.json([
          { id: "other", runtime: { command: ["another-agent"] } },
          { id: "claude-1", runtime: { command: ["archestra-claude-code"] } },
          { id: "claude-2", runtime: { command: ["archestra-claude-code"] } },
        ]),
      ),
      http.get(
        `${origin}/api/agents/claude-1/runtime/claude-code/account`,
        () => HttpResponse.json({ state: "disconnected" }),
      ),
      http.post(
        `${origin}/api/agents/claude-1/runtime/claude-code/account`,
        () =>
          HttpResponse.json({
            state: "awaiting_code",
            flowId: "flow-1",
            authorizationUrl: "https://claude.ai/oauth/authorize",
          }),
      ),
    );
    renderPage();
    expect(await screen.findAllByText("Claude Code")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Connections" })).toBeVisible();
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    await user.click(
      screen.getByRole("button", { name: "Sign in with Claude" }),
    );
    expect(
      await screen.findByRole("link", { name: "Open Claude sign-in" }),
    ).toHaveAttribute("href", "https://claude.ai/oauth/authorize");
    expect(screen.getByLabelText("Authorization code")).toBeVisible();
  });

  it("does not hide a failed Agent lookup as an empty connections list", async () => {
    server.use(
      http.get(`${origin}/api/credentials`, () => HttpResponse.json([])),
      http.get(
        `${origin}/api/agents/all`,
        () => new HttpResponse(null, { status: 503 }),
      ),
    );
    renderPage();
    expect(
      await screen.findByText("Couldn't load Agent connections"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Sign in" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connections" })).toBeVisible();
  });

  it("waits for a confirmed empty result, then hides the section", async () => {
    let finish!: () => void;
    let requested = false;
    const response = new Promise<void>((resolve) => {
      finish = resolve;
    });
    server.use(
      http.get(`${origin}/api/credentials`, async () => {
        requested = true;
        await response;
        return HttpResponse.json([
          { allowPersonal: false, allowOrganization: true },
        ]);
      }),
    );
    renderPage();
    await waitFor(() => expect(requested).toBe(true));
    finish();
    await waitFor(() =>
      expect(client.isFetching({ queryKey: runtimeCredentialsQueryKey })).toBe(
        0,
      ),
    );
    expect(
      screen.queryByRole("heading", { name: "Connections" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/An administrator can add a personal credential/),
    ).not.toBeInTheDocument();
  });

  it("revalidates an empty cache before deciding whether connections are applicable", async () => {
    client.setQueryData(runtimeCredentialsQueryKey, []);
    let finish!: () => void;
    let requested = false;
    const response = new Promise<void>((resolve) => {
      finish = resolve;
    });
    server.use(
      http.get(`${origin}/api/credentials`, async () => {
        requested = true;
        await response;
        return HttpResponse.json([
          {
            id: "00000000-0000-4000-8000-000000000001",
            githubUrl: null,
            appId: null,
            installationId: null,
            githubClientId: null,
            githubAppCredentialKey: null,
            kind: "secret",
            key: "repository-token",
            name: "Repository token",
            description: "Repository access",
            icon: "key",
            builtIn: false,
            allowPersonal: true,
            allowOrganization: false,
            personalConfigured: false,
            organizationConfigured: false,
          } satisfies RuntimeCredentialDefinition,
        ]);
      }),
    );
    renderPage();
    await waitFor(() => expect(requested).toBe(true));
    await waitFor(() =>
      expect(client.isFetching({ queryKey: ["agents"] })).toBe(0),
    );
    finish();
    expect(
      await screen.findByRole("button", { name: "Connect Repository token" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Connections" })).toBeVisible();
  });

  it("hides Connections without fetching runtime data when the runtime is disabled", async () => {
    vi.mocked(useFeature).mockReturnValue(false);
    let requests = 0;
    server.use(
      http.get(`${origin}/api/credentials`, () => {
        requests++;
        return HttpResponse.json([]);
      }),
      http.get(`${origin}/api/agents/all`, () => {
        requests++;
        return HttpResponse.json([]);
      }),
    );
    renderPage();
    expect(
      screen.queryByRole("heading", { name: "Connections" }),
    ).not.toBeInTheDocument();
    expect(requests).toBe(0);
  });
});
