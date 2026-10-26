import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { delay, HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useRouter, useSearchParams } from "next/navigation";
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
import { useAppName } from "@/lib/hooks/use-app-name";
import OrganizationCostsPage from "./page";

vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config/config.query")>()),
  useFeature: () => false,
}));
vi.mock("@/lib/integration-overrides", () => ({
  useModelProviderCatalog: () => ({ label: (provider: string) => provider }),
}));
vi.mock("sonner");
const origin = "http://localhost:9000";
const server = setupServer();
let search = new URLSearchParams();
let models: Record<string, unknown>[];
let users: Record<string, unknown>[];
let teams: Record<string, unknown>[];
let agents: Record<string, unknown>[];
let apps: Record<string, unknown>[];
let skills: Record<string, unknown>[];
let skillsUsage: Record<string, unknown>[];
let savings: Record<string, unknown>;
let requests: URL[];
let pending = false;
let client: QueryClient;
const paginated = (data: unknown[]) => ({
  data,
  pagination: {
    currentPage: 1,
    limit: 100,
    total: data.length,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
  },
});
const model = (name = "example/model-a", cost = 8.25) => ({
  model: name,
  requests: 10,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 4000,
  cacheWriteTokens: 0,
  totalTokens: 5200,
  cost,
  percentage: 100,
  timeSeries: [],
});
function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OrganizationCostsPage />
    </QueryClientProvider>,
  );
}
async function view(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: /^View / }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}
async function group(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: /^by / }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}
async function metric(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: /^Show / }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}
async function split(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: /^split by / }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: origin });
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
afterEach(() => {
  cleanup();
  client?.clear();
  server.resetHandlers();
  vi.restoreAllMocks();
});
beforeEach(() => {
  localStorage.clear();
  search = new URLSearchParams();
  pending = false;
  requests = [];
  models = [model()];
  users = [];
  teams = [];
  agents = [];
  apps = [];
  skills = [];
  skillsUsage = [];
  savings = {
    totalActualCost: 8.25,
    totalSubscriptionCost: 14.5,
    timeSeries: [],
  };
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useSearchParams).mockImplementation(
    () => search as unknown as ReturnType<typeof useSearchParams>,
  );
  vi.mocked(useAppName).mockReturnValue("Example Platform");
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
    isLoading: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 1000,
    height: 260,
    x: 0,
    y: 0,
    top: 0,
    bottom: 260,
    left: 0,
    right: 1000,
    toJSON: () => ({}),
  });
  server.use(
    http.get(`${origin}/api/statistics/:kind`, async ({ request, params }) => {
      requests.push(new URL(request.url));
      if (pending) await delay("infinite");
      switch (params.kind) {
        case "costs":
          return HttpResponse.json({
            models,
            costSavings: savings,
            activeUsers: users.length,
          });
        case "models":
          return HttpResponse.json(models);
        case "teams":
          return HttpResponse.json(teams);
        case "agents":
          return HttpResponse.json(agents);
        case "users":
          return HttpResponse.json(paginated(users));
        case "apps":
          return HttpResponse.json({
            ...paginated(apps),
            chatBaselineCostPerSession: 0.75,
            chatBaselineSessions: 12,
          });
        case "skills":
          return HttpResponse.json(paginated(skills));
        case "skill-usage":
          return HttpResponse.json({
            ...paginated(skillsUsage),
            totals: { activations: 5, contextTokens: 6420, users: 3 },
          });
        case "app-usage":
          return HttpResponse.json({
            ...paginated([]),
            totals: {
              runs: 0,
              toolCalls: 0,
              llmRequests: 0,
              inputTokens: 0,
              outputTokens: 0,
              billedCost: 0,
              subscriptionCost: 0,
            },
          });
        case "llm-proxy":
          return HttpResponse.json({
            totals: { requests: 0 },
            timeSeries: [],
            methods: [],
            credentials: [],
            pagination: { total: 0, limit: 100, offset: 0 },
          });
        case "cost-savings":
          return HttpResponse.json(savings);
        default:
          return HttpResponse.json(
            { error: { message: "Unexpected endpoint" } },
            { status: 500 },
          );
      }
    }),
  );
});

describe("OrganizationCostsPage", () => {
  it("holds placeholders rather than zeros until statistics arrive", async () => {
    pending = true;
    const { container } = show();
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing to tabulate.")).not.toBeInTheDocument();
    expect(screen.getByText("Metered API-key charges")).toBeInTheDocument();
  });
  it("shows organization analytics and all supported entity choices", async () => {
    show();
    await screen.findAllByText("$8.25");
    fireEvent.keyDown(screen.getByRole("button", { name: "by Model" }), {
      key: "Enter",
    });
    for (const name of ["Team", "Agent", "Model", "Person", "App", "Key"])
      expect(await screen.findByRole("menuitem", { name })).toBeVisible();
    expect(screen.queryByTestId("my-usage-summary")).not.toBeInTheDocument();
  });
  it("summarizes metered, subscription, request, token and active-person totals", async () => {
    users = [
      {
        userId: "one",
        userName: "Example",
        userEmail: "one@example.test",
        requests: 10,
      },
    ];
    show();
    await screen.findAllByText("$8.25");
    expect(screen.getByText("$14.50")).toBeInTheDocument();
    expect(screen.getByText("5.2K")).toBeInTheDocument();
    expect(
      screen.getByText("Usage at API rates, not a bill"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Active people").parentElement?.parentElement,
    ).toHaveTextContent(/^Active people1/);
    // The totals only summarize; the explorer's controls pick what it shows.
    expect(
      screen.queryByRole("button", { name: /API spend/ }),
    ).not.toBeInTheDocument();
  });
  it("uses the selected custom timeframe for all requested data", async () => {
    const timeframe =
      "custom:2026-07-01T00:00:00.000Z_2026-07-31T23:59:59.999Z";
    search = new URLSearchParams({ timeframe });
    show();
    await screen.findAllByText("$8.25");
    await group("Team");
    await waitFor(() =>
      expect(requests.some((url) => url.pathname.endsWith("/teams"))).toBe(
        true,
      ),
    );
    expect(
      requests.every((url) => url.searchParams.get("timeframe") === timeframe),
    ).toBe(true);
  });
  it("never requests a default timeframe before resolving the persisted timeframe", async () => {
    localStorage.setItem("cost-statistics-timeframe", "30d");
    show();
    await screen.findAllByText("$8.25");
    expect(
      requests.every((url) => url.searchParams.get("timeframe") === "30d"),
    ).toBe(true);
  });
  it("shows a subscription user's identity, usage and model mix without calling it billed spend", async () => {
    users = [
      {
        userId: "one",
        userName: "Example User A",
        userEmail: "user-a@example.test",
        requests: 42,
        inputTokens: 900,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 1000,
        billedCost: 0,
        subscriptionCost: 12.5,
        models: [
          {
            model: "claude-sonnet-4",
            requests: 40,
            inputTokens: 880,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 980,
          },
          {
            model: "gpt-5",
            requests: 2,
            inputTokens: 20,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 20,
          },
        ],
      },
    ];
    show();
    await screen.findAllByText("$8.25");
    await view("Who is using it");
    await within(await screen.findByRole("table")).findByText("Example User A");
    await split("Model");
    fireEvent.click(
      await screen.findByRole("button", { name: "Expand by Model" }),
    );
    expect(
      await within(screen.getByRole("table")).findByText("claude-sonnet-4"),
    ).toBeInTheDocument();
    expect(screen.getByText("user-a@example.test")).toBeInTheDocument();
    expect(screen.getByText("Subscription usage")).toBeInTheDocument();
    expect(
      within(screen.getByRole("table")).getByText("1,000"),
    ).toBeInTheDocument();
  });
  it("renders a malformed custom timeframe without throwing", async () => {
    search = new URLSearchParams({
      timeframe: "custom:not-a-date_also-not-a-date",
    });
    show();
    expect((await screen.findAllByText("$8.25")).length).toBeGreaterThan(0);
  });
  it("labels subdaily buckets distinctly on a multi-day chart", async () => {
    search = new URLSearchParams({ timeframe: "7d" });
    models = [
      {
        ...model(),
        timeSeries: [
          "2026-07-01T00:00:00Z",
          "2026-07-01T06:00:00Z",
          "2026-07-01T12:00:00Z",
          "2026-07-01T18:00:00Z",
          "2026-07-02T00:00:00Z",
        ].map((timestamp) => ({ timestamp, value: 1 })),
      },
    ];
    show();
    await screen.findAllByText("$8.25");
    fireEvent.click(screen.getByRole("button", { name: "Pivot" }));
    await waitFor(() => {
      const headers = within(screen.getByRole("table"))
        .getAllByRole("columnheader")
        .slice(1, -1)
        .map((node) => node.textContent);
      expect(headers).toHaveLength(5);
      expect(new Set(headers).size).toBe(5);
    });
  });
  it("shows a metered person's spend as money rather than savings percent", async () => {
    users = [
      {
        userId: "one",
        userName: "Example User B",
        userEmail: "user-b@example.test",
        requests: 15260,
        inputTokens: 19000000,
        outputTokens: 572756,
        cacheReadTokens: 0,
        billedCost: 41.4405,
        subscriptionCost: 0,
      },
    ];
    show();
    await screen.findAllByText("$8.25");
    await group("Person");
    expect(
      await within(await screen.findByRole("table")).findByText("$41.44"),
    ).toBeInTheDocument();
    const row = within(screen.getByRole("table"))
      .getByText("Example User B")
      .closest("tr");
    expect(
      within(row as HTMLElement).queryByText("0%", { exact: true }),
    ).not.toBeInTheDocument();
  });
  it("keeps full person identities and subscription badges in the summary row", async () => {
    users = [
      {
        userId: "one",
        userName: "Example User C with a long identity",
        userEmail: "long-identity@example.test",
        requests: 118,
        inputTokens: 3000000,
        outputTokens: 883994,
        billedCost: 0,
        subscriptionCost: 4,
      },
    ];
    show();
    await screen.findAllByText("$8.25");
    await view("Who is using it");
    const identity = await within(await screen.findByRole("table")).findByText(
      "Example User C with a long identity",
    );
    expect(identity.closest("tr")).toHaveTextContent(
      "long-identity@example.test",
    );
    expect(identity.closest("tr")).toHaveTextContent("Subscription usage");
  });
  it("ranks costliest model series and uses CSS-safe chart keys", async () => {
    models = [
      model("google/gemini-3-pro-preview", 0.1),
      model("anthropic/claude-opus-4.8", 46),
      model("moonshotai/kimi-k2-thinking", 0.64),
      model("openrouter/auto", 4.21),
      model("deepseek/deepseek-v3.1-terminus", 5),
      model("z-ai/glm-4.6", 1.64),
    ].map((row) => ({
      ...row,
      timeSeries: [{ timestamp: "2026-01-01T00:00:00Z", value: row.cost }],
    }));
    const { container } = show();
    const legend = await screen.findByRole("list", {
      name: "Usage chart legend",
    });
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((node) => node.textContent),
    ).toEqual([
      "anthropic/claude-opus-4.8",
      "deepseek/deepseek-v3.1-terminus",
      "openrouter/auto",
      "z-ai/glm-4.6",
      "moonshotai/kimi-k2-thinking",
      "google/gemini-3-pro-preview",
    ]);
    const css = [...container.querySelectorAll("style")]
      .map((node) => node.textContent)
      .join(" ");
    const keys = [...css.matchAll(/--color-([^:]+):/g)].map(
      (match) => match[1],
    );
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => /^[A-Za-z0-9_-]+$/.test(key))).toBe(true);
  });
  it("renders each selected entity in one reusable table", async () => {
    teams = [
      {
        teamId: "team",
        teamName: "Platform",
        members: 3,
        agents: 2,
        requests: 12,
        inputTokens: 100,
        outputTokens: 50,
        cost: 42,
        timeSeries: [],
      },
    ];
    agents = [
      {
        agentId: "agent",
        agentName: "My Assistant",
        teamName: "Platform",
        requests: 9,
        inputTokens: 80,
        outputTokens: 20,
        cost: 15,
        timeSeries: [],
      },
    ];
    show();
    await screen.findAllByText("$8.25");
    await group("Team");
    expect(
      await within(await screen.findByRole("table")).findByText("Platform"),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(1);
    await group("Agent");
    expect(
      await within(await screen.findByRole("table")).findByText("My Assistant"),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });
  it("splits app build/runtime spend and discloses a shared build session and baseline", async () => {
    apps = [
      {
        appId: "app",
        appName: "Sales Dashboard",
        authorName: "Example",
        buildCost: 1.5,
        runtimeCost: 0.25,
        hasBuildSession: true,
        buildSessionAppCount: 2,
        estimatedChatEquivalentCost: 22.5,
        estimatedNetSavings: 20.75,
      },
    ];
    show();
    await screen.findAllByText("$8.25");
    await group("App");
    expect(
      await within(await screen.findByRole("table")).findByText(
        "Sales Dashboard",
      ),
    ).toBeInTheDocument();
    for (const value of ["$1.50", "$0.25", "$20.75"])
      expect(screen.getByText(value)).toBeInTheDocument();
    expect(
      screen.getByText("Shared build session · 2 apps"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/measured average of \$0.75 across 12 chat sessions/),
    ).toBeInTheDocument();
  });
  it("reports missing app build attribution as unknown rather than zero", async () => {
    apps = [
      {
        appId: "app",
        appName: "Made In The UI",
        authorName: null,
        buildCost: 0,
        runtimeCost: 0,
        hasBuildSession: false,
        buildSessionAppCount: 0,
        estimatedChatEquivalentCost: 1.5,
        estimatedNetSavings: 1.5,
      },
    ];
    show();
    await screen.findAllByText("$8.25");
    await group("App");
    const row = (
      await within(await screen.findByRole("table")).findByText(
        "Made In The UI",
      )
    ).closest("tr");
    expect(row).toHaveTextContent("No recorded build session");
    const buildIndex = within(screen.getByRole("table"))
      .getAllByRole("columnheader")
      .findIndex((header) => header.textContent === "Build spend");
    expect(
      within(row as HTMLElement).getAllByRole("cell")[buildIndex],
    ).toHaveTextContent(/^—$/);
  });
  it("shows skill context footprint alongside overlapping turn spend and measurement coverage", async () => {
    skillsUsage = [
      {
        skillId: "skill",
        skillName: "PDF Extraction",
        activations: 5,
        contextTokens: 6420,
        users: 3,
      },
    ];
    skills = [
      {
        skillId: "skill",
        skillName: "PDF Extraction",
        activations: 5,
        measuredActivations: 3,
        attributedCost: 1.68,
        attributedRequests: 12,
      },
    ];
    show();
    await screen.findAllByText("$8.25");
    await view("Skills by reach");
    expect(
      await within(await screen.findByRole("table")).findByText(
        "PDF Extraction",
      ),
    ).toBeInTheDocument();
    await metric("Tokens");
    expect(
      await within(await screen.findByRole("table")).findByText("6,420"),
    ).toBeInTheDocument();
    expect(screen.getByText("$1.68")).toBeInTheDocument();
    expect(screen.getByText("3 of 5 context measurements")).toBeInTheDocument();
    expect(screen.getByText(/not an exclusive skill cost/)).toBeInTheDocument();
  });
});
