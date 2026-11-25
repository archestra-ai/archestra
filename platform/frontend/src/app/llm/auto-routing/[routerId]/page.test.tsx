import { randomUUID } from "node:crypto";
import {
  AUTO_ROUTING_BACKFILL_MAX_COST_USD,
  archestraApiClient,
  type archestraApiTypes,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { toast } from "sonner";
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
import {
  type AutoRouter,
  AutoRouterIdContext,
  type AutoRouterUpdate,
  type AutoRoutingBackfillState,
  type AutoRoutingPlanDetail,
  type AutoRoutingSimulation,
  type AutoRoutingState,
  type AutoRoutingUsage,
} from "@/lib/auto-routing.query";
import type { LlmModel } from "@/lib/llm-models.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import { formatDate } from "@/lib/utils/date-time";
import { ConfigureAutoRoutingButton } from "../_parts/configure-button";
import AutoRoutingOverviewPage from "./page";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("sonner");

// Radix Select needs pointer capture and scrolling, which jsdom lacks.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

const API_ORIGIN = "http://localhost:9000";
const PLAN_ID = "00000000-0000-4000-8000-000000000001";
const ROUTER_ID = "00000000-0000-4000-8000-0000000000a1";
const ROUTER_URL = `${API_ORIGIN}/api/auto-routing/routers/${ROUTER_ID}`;

const ORG_KEY = { id: "00000000-0000-4000-8000-000000000501", name: "Org key" };
const tier = (modelId: string, index: number) => ({
  id: `00000000-0000-4000-8000-00000000010${index}`,
  provider: "anthropic" as const,
  modelId,
  apiKey: ORG_KEY,
});

function makeState(
  overrides: Partial<AutoRoutingState> = {},
): AutoRoutingState {
  return {
    enabled: true,
    eligibleApiKeyIds: [ORG_KEY.id],
    decisionProviders: [
      {
        provider: "jev",
        models: [{ id: "jev-1.13.0", displayName: "Jev 1.13" }],
        apiKeys: [],
      },
    ],
    defaultDecisionModel: "jev-1.13.0",
    ...overrides,
  };
}

function makeSettings(overrides: Partial<AutoRouter> = {}): AutoRouter {
  return {
    id: ROUTER_ID,
    name: "auto",
    enabled: true,
    decisionModel: { apiKeyId: null, model: "jev-1.13.0" },
    learnFromPastSessions: true,
    readsPastSessions: true,
    expectedTrafficFactor: 1,
    traffic: { volumeSource: "live", pastBaseline: null },
    virtualApiKeyIds: [],
    budgetUsdPerDay: 20,
    budgetPreset: null,
    tiers: {
      fast: tier("claude-haiku", 1),
      normal: tier("claude-sonnet", 2),
      smart: tier("claude-opus", 3),
    },
    usage: { agentCount: 2, organizationDefault: false },
    generation: 3,
    plannedGeneration: 3,
    status: {
      activePlan: null,
      coldStart: {
        scorerVersionId: "00000000-0000-4000-8000-000000000009",
        sessions: 12,
        required: 100,
      },
      lastFitError: null,
      scorer: "ready",
      scorerApiKey: { id: "00000000-0000-4000-8000-000000000502", name: "Jev" },
    },
    ...overrides,
  };
}

const activePlan: AutoRoutingPlanDetail = {
  id: PLAN_ID,
  createdAt: "2026-10-20T08:00:00.000Z",
  trigger: "nightly",
  status: "active",
  generation: 3,
  inputWatermark: "2026-10-20T08:00:00.000Z",
  budgetUsdPerDay: 20,
  scorerVersion: {
    id: "00000000-0000-4000-8000-000000000009",
    name: "jev",
    model: "jev-1.13.0",
    specHash: "abcdef0123456789",
  },
  coreVersion: "0.1.0",
  planFormatVersion: 1,
  summary: {
    sessions_per_day: 140,
    tokens_per_day: 9_000_000,
    expected_spend: 12.5,
    value_size_weighted: 0.84,
    tier_session_share: [0.5, 0.3, 0.2],
    tier_token_share: [0.2, 0.3, 0.5],
    frontier: [
      { spend: 4, value: 0.6 },
      { spend: 12.5, value: 0.84 },
      { spend: 20, value: 0.94 },
      { spend: 40, value: 1 },
    ],
  },
  diagnostics: { holdout: { status: "insufficient_history" } },
  error: null,
  decisionCount: 420,
  tiersFingerprint: {},
  plan: null,
};

const emptyUsage: AutoRoutingUsage = {
  windowDays: 7,
  sessions: 0,
  requests: 0,
  costUsd: 0,
  allSmartCostUsd: 0,
  tiers: [
    { tier: "fast", sessions: 0, requests: 0, costUsd: 0 },
    { tier: "normal", sessions: 0, requests: 0, costUsd: 0 },
    { tier: "smart", sessions: 0, requests: 0, costUsd: 0 },
  ],
};

function catalogModel(
  dbId: string,
  id: string,
  supportsToolCalling: boolean | null,
): LlmModel {
  return {
    id,
    dbId,
    displayName: id,
    provider: "anthropic",
    isFree: false,
    capabilities: {
      contextLength: null,
      inputModalities: null,
      outputModalities: null,
      supportsToolCalling,
      supportsReasoningEffort: null,
      outputLength: null,
      supportedReasoningEfforts: null,
      recommendedForAgents: null,
      pricePerMillionInput: null,
      pricePerMillionOutput: null,
      isCustomPrice: false,
      priceSource: "default",
      pricePerMillionCacheRead: null,
      pricePerMillionCacheWrite: null,
      cachePriceSource: "default",
      mediaPricing: null,
    },
  };
}

let settings: AutoRouter;
let state: AutoRoutingState;
const updates: AutoRouterUpdate[] = [];

const server = setupServer(
  http.get(`${API_ORIGIN}/api/auto-routing/state`, () =>
    HttpResponse.json(state),
  ),
  http.get(`${API_ORIGIN}/api/auto-routing/routers`, () =>
    HttpResponse.json([settings]),
  ),
  http.put(ROUTER_URL, async ({ request }) => {
    updates.push((await request.json()) as AutoRouterUpdate);
    return HttpResponse.json({ ...settings, fit: null });
  }),
  http.get(`${ROUTER_URL}/plans/${PLAN_ID}`, () =>
    HttpResponse.json(activePlan),
  ),
  http.get(`${ROUTER_URL}/usage`, () => HttpResponse.json(emptyUsage)),
  http.get(`${API_ORIGIN}/api/llm-models/available`, () =>
    HttpResponse.json([]),
  ),
  http.get(`${API_ORIGIN}/api/auto-routing/backfill`, () =>
    HttpResponse.json({
      backfill: null,
      scoreOffer: null,
      payer: "ready",
      history: [],
    } satisfies AutoRoutingBackfillState),
  ),
  http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
    HttpResponse.json([]),
  ),
  http.get(`${API_ORIGIN}/api/llm-models`, () => HttpResponse.json([])),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});

beforeEach(() => {
  vi.clearAllMocks();
  settings = makeSettings();
  state = makeState();
  updates.length = 0;
  setCanUpdate(true);
  vi.mocked(useOrganization).mockReturnValue({
    data: null,
  } as unknown as ReturnType<typeof useOrganization>);
  vi.mocked(useAppearanceSettings).mockReturnValue({
    data: null,
  } as unknown as ReturnType<typeof useAppearanceSettings>);
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("AutoRoutingOverviewPage", () => {
  it("saves the expected traffic and learning from past sessions only when edited", async () => {
    const user = userEvent.setup();
    renderPage();
    await openConfigure(user);
    const factor = screen.getByLabelText("Expected traffic");
    await user.clear(factor);
    await user.type(factor, "3");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updates).toEqual([{ expectedTrafficFactor: 3 }]),
    );

    await openConfigure(user);
    await user.click(screen.getByLabelText("Learn from past sessions"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updates).toEqual([
        { expectedTrafficFactor: 3 },
        { learnFromPastSessions: false },
      ]),
    );
  });

  it("ignores the hidden traffic factor once learning from past sessions is off", async () => {
    const user = userEvent.setup();
    renderPage();
    await openConfigure(user);
    const factor = screen.getByLabelText("Expected traffic");
    await user.clear(factor);
    await user.type(factor, "0");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.click(screen.getByLabelText("Learn from past sessions"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updates).toEqual([{ learnFromPastSessions: false }]),
    );
  });

  it("shows no split for a draft that reads past sessions differently from the saved router", async () => {
    settings = makeSettings({
      status: {
        ...makeSettings().status,
        coldStart: { ...makeSettings().status.coldStart, sessions: 120 },
      },
    });
    server.use(
      http.post(`${ROUTER_URL}/simulate`, () =>
        HttpResponse.json(feasibleSimulation(0.9)),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await openConfigure(user);
    expect(
      await screen.findByTestId("auto-routing-budget-split"),
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText("Learn from past sessions"));
    expect(
      screen.queryByTestId("auto-routing-budget-split"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("auto-routing-budget-note")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Learn from past sessions"));
    expect(
      await screen.findByTestId("auto-routing-budget-split"),
    ).toBeInTheDocument();
  });

  it("saves only the edited budget", async () => {
    const user = userEvent.setup();
    renderPage();
    const budget = await openConfigure(user);
    await user.clear(budget);
    await user.type(budget, "55.5");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updates).toEqual([{ budgetUsdPerDay: 55.5 }]));
  });

  it("names a saved key not shared with the whole organization, and still saves the budget", async () => {
    state = makeState({ eligibleApiKeyIds: [] });
    server.use(
      http.get(`${API_ORIGIN}/api/llm-provider-api-keys`, () =>
        HttpResponse.json([
          { ...ORG_KEY, provider: "anthropic", scope: "org" },
        ]),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    const budget = await openConfigure(user);

    expect(
      await screen.findByText(
        '"Org key" is not shared with the whole organization',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Fast provider key" }),
    ).toHaveTextContent("Org key");

    await user.clear(budget);
    await user.type(budget, "30");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updates).toEqual([{ budgetUsdPerDay: 30 }]));
  });

  it("offers a retry when the settings fail to load", async () => {
    let fail = true;
    server.use(
      http.get(`${API_ORIGIN}/api/auto-routing/routers`, () =>
        fail
          ? HttpResponse.json(
              { error: { message: "Unavailable" } },
              { status: 500 },
            )
          : HttpResponse.json([settings]),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(
      screen.queryByTestId("auto-routing-details"),
    ).not.toBeInTheDocument();

    fail = false;
    await user.click(retry);

    expect(
      await screen.findByTestId("auto-routing-details"),
    ).toBeInTheDocument();
  });

  it("starts on Balanced when no budget was ever set", async () => {
    settings = makeSettings({ budgetUsdPerDay: null });
    const user = userEvent.setup();
    renderPage();
    await user.click(
      (await screen.findAllByRole("button", { name: "Configure" }))[0],
    );
    expect(
      await screen.findByRole("radio", { name: /Balanced/ }),
    ).toBeChecked();
    expect(screen.queryByLabelText("USD per day")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: /Cost-efficient/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updates).toEqual([{ budgetPreset: "cost_efficient" }]),
    );
  });

  it("requires a custom budget once Custom is chosen", async () => {
    settings = makeSettings({ budgetUsdPerDay: null });
    const user = userEvent.setup();
    renderPage();
    await user.click(
      (await screen.findAllByRole("button", { name: "Configure" }))[0],
    );
    await user.click(await screen.findByRole("radio", { name: /Custom/ }));

    expect(await screen.findByText("Set a daily budget.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(updates).toEqual([]);
  });

  it("switching from a custom budget to a preset saves only the preset and shows what it costs today", async () => {
    settings = makeSettings({
      status: {
        ...makeSettings().status,
        coldStart: { ...makeSettings().status.coldStart, sessions: 120 },
      },
    });
    const simulated: unknown[] = [];
    server.use(
      http.post(`${ROUTER_URL}/simulate`, async ({ request }) => {
        simulated.push(await request.json());
        return HttpResponse.json({
          ...feasibleSimulation(0.9),
          budgetUsdPerDay: 12.34,
        });
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await openConfigure(user);
    await user.click(screen.getByRole("radio", { name: /Intelligence/ }));

    await waitFor(() =>
      expect(
        screen.getByTestId("auto-routing-preset-estimate"),
      ).toHaveTextContent("≈ $12.34/day"),
    );
    expect(screen.getByTestId("auto-routing-budget-split")).toHaveTextContent(
      "50% fast30% normal20% smart",
    );
    expect(simulated).toEqual([
      { budgetUsdPerDay: 20, expectedTrafficFactor: 1 },
      { budgetPreset: "intelligence", expectedTrafficFactor: 1 },
    ]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updates).toEqual([{ budgetPreset: "intelligence" }]),
    );
  });

  it("shows where sessions would land for a typed custom budget", async () => {
    settings = makeSettings({
      status: {
        ...makeSettings().status,
        coldStart: { ...makeSettings().status.coldStart, sessions: 120 },
      },
    });
    const simulated: { budgetUsdPerDay?: number }[] = [];
    server.use(
      http.post(`${ROUTER_URL}/simulate`, async ({ request }) => {
        const body = (await request.json()) as { budgetUsdPerDay: number };
        simulated.push(body);
        if (body.budgetUsdPerDay < 5) {
          return HttpResponse.json({
            status: "infeasible",
            minBudgetUsdPerDay: 7.5,
            baseline: { tokensPerDay: 10_000_000, sessionsPerDay: 150 },
          });
        }
        return HttpResponse.json({
          ...feasibleSimulation(0.9),
          budgetUsdPerDay: body.budgetUsdPerDay,
          summary: {
            ...activePlan.summary,
            tier_session_share: [0.1, 0.6, 0.3],
          },
        });
      }),
    );
    const user = userEvent.setup();
    renderPage();
    const budget = await openConfigure(user);
    await user.clear(budget);
    await user.type(budget, "35");

    await waitFor(() =>
      expect(simulated).toContainEqual({
        budgetUsdPerDay: 35,
        expectedTrafficFactor: 1,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("auto-routing-budget-split")).toHaveTextContent(
        "10% fast60% normal30% smart",
      ),
    );

    await user.clear(budget);
    await user.type(budget, "2");
    expect(
      await screen.findByText("Today's traffic needs at least $7.50/day."),
    ).toBeInTheDocument();
    expect(updates).toEqual([]);
  });

  it("opens on the saved preset and explains a preset during cold start", async () => {
    settings = makeSettings({ budgetPreset: "cost_efficient" });
    const user = userEvent.setup();
    renderPage();
    await user.click(
      (await screen.findAllByRole("button", { name: "Configure" }))[0],
    );

    expect(
      await screen.findByRole("radio", { name: /Cost-efficient/ }),
    ).toBeChecked();
    expect(screen.getByTestId("auto-routing-budget-note")).toHaveTextContent(
      "Set after 100 sessions (12 so far)",
    );
    await user.click(screen.getByRole("radio", { name: /Custom/ }));
    const budget = screen.getByLabelText("USD per day");
    await user.clear(budget);
    await user.type(budget, "40");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updates).toEqual([{ budgetPreset: null, budgetUsdPerDay: 40 }]),
    );
  });
  it("shows what the router is made of", async () => {
    renderPage();

    const details = await screen.findByTestId("auto-routing-details");
    expect(details).toHaveTextContent("Fastclaude-haikuOrg key");
    expect(details).toHaveTextContent("Daily budget$20.00/day");
    expect(details).toHaveTextContent("Decision modeljev-1.13.0Jev");
  });

  it("shows the setup steps until a tier is set, with the tiers set so far", async () => {
    settings = makeSettings({
      tiers: { ...makeSettings().tiers, smart: null },
    });
    server.use(
      http.get(`${API_ORIGIN}/api/llm-models/available`, () =>
        HttpResponse.json([
          {
            ...catalogModel(
              settings.tiers.fast?.id ?? "",
              "claude-haiku",
              true,
            ),
            displayName: "Claude Haiku",
          },
        ]),
      ),
    );
    renderPage();

    const models = await screen.findByTestId("auto-routing-setup-2");
    expect(within(models).getByText("2 of 3 set")).toBeInTheDocument();
    await waitFor(() =>
      expect(models).toHaveTextContent(/Fast\s*Claude Haiku/),
    );
    expect(models).toHaveTextContent(/Smart\s*Not set/);
    expect(screen.getByTestId("auto-routing-setup-1")).toHaveTextContent(
      "Connected",
    );
    expect(
      screen.queryByTestId("auto-routing-details"),
    ).not.toBeInTheDocument();
  });

  it("asks for a Jev key until one is connected", async () => {
    settings = makeSettings({
      status: {
        ...makeSettings().status,
        scorer: "no_jev_key",
        scorerApiKey: null,
      },
    });
    renderPage();

    const jev = await screen.findByTestId("auto-routing-setup-1");
    expect(jev).toHaveTextContent("Needed");
    expect(within(jev).getByTestId("auto-routing-add-jev-key")).toHaveAttribute(
      "href",
      "/llm/model-providers?create=jev&access=organization",
    );
  });
  it("rejects a budget below a cent without saving", async () => {
    const user = userEvent.setup();
    renderPage();
    const budget = await openConfigure(user);
    await user.clear(budget);
    await user.type(budget, "0");

    expect(
      await screen.findByText(/Enter a budget between 0.01/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(updates).toEqual([]);
  });
  it("does not offer read-only viewers the Configure dialog", async () => {
    setCanUpdate(false);
    renderPage();

    expect(
      await screen.findByTestId("auto-routing-details"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Configure" }),
    ).not.toBeInTheDocument();
  });
  it("says it is evaluating and keeps the figures, empty, while no plan is active", async () => {
    renderPage();

    expect(
      await screen.findByTestId("auto-routing-evaluating"),
    ).toHaveTextContent("Evaluating sessions");
    const placeholder = screen.getByTestId("auto-routing-plan-placeholder");
    expect(placeholder).toHaveTextContent("Expected spend");
    expect(placeholder).toHaveTextContent("of $20.00 budget");
    expect(placeholder).toHaveTextContent("100.0% sessions");
  });

  it("shows the failed fit instead of the evaluating notice", async () => {
    const base = makeSettings();
    settings = makeSettings({
      status: { ...base.status, lastFitError: "fit exploded" },
    });
    renderPage();

    expect(await screen.findByText("Last fit failed")).toBeInTheDocument();
    expect(
      screen.queryByTestId("auto-routing-evaluating"),
    ).not.toBeInTheDocument();
  });

  it("summarizes the active plan", async () => {
    settings = makeSettings({
      status: {
        ...makeSettings().status,
        activePlan: { id: PLAN_ID, createdAt: activePlan.createdAt },
      },
    });
    renderPage();

    expect(await screen.findByText("$12.50/day")).toBeInTheDocument();
    expect(screen.getByText("84.0%")).toBeInTheDocument();
    // $12.50 × 25% rounds down to $2; the frontier gains 0.1 per $7.50 there
    expect(screen.getByText("Extra $2/day")).toBeInTheDocument();
    expect(screen.getByText("+2.7 points")).toBeInTheDocument();
    expect(screen.getByTestId("auto-routing-plan-caption")).toHaveTextContent(
      "Plan updated",
    );
    expect(
      screen.queryByTestId("auto-routing-evaluating"),
    ).not.toBeInTheDocument();
  });

  it("switches to what the router routed and what it saved against all-smart", async () => {
    const asked: string[] = [];
    server.use(
      http.get(`${ROUTER_URL}/usage`, ({ request }) => {
        const days = new URL(request.url).searchParams.get("days") ?? "";
        asked.push(days);
        return HttpResponse.json({
          windowDays: Number(days),
          sessions: 40,
          requests: 300,
          costUsd: 28,
          allSmartCostUsd: 112,
          tiers: [
            { tier: "fast", sessions: 30, requests: 200, costUsd: 7 },
            { tier: "normal", sessions: 8, requests: 80, costUsd: 9 },
            { tier: "smart", sessions: 2, requests: 20, costUsd: 12 },
          ],
        } satisfies AutoRoutingUsage);
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole("button", {
        name: "What it routed in the last 7 days",
      }),
    );
    const usage = await screen.findByTestId("auto-routing-usage");
    expect(await within(usage).findByText("$28.00")).toBeInTheDocument();
    expect(usage).toHaveTextContent("$4.00/day on average");
    expect(within(usage).getByText("$84.00")).toBeInTheDocument();
    expect(usage).toHaveTextContent(
      "75% less than sending everything to claude-opus",
    );
    expect(usage).toHaveTextContent("300 requests");
    expect(
      within(usage).getByText("fast · claude-haiku: 30 sessions, $7.00"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("auto-routing-plan-placeholder"),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "What it routed in the last 14 days",
      }),
    );
    expect(
      await within(screen.getByTestId("auto-routing-usage")).findByText(
        "$2.00/day on average",
      ),
    ).toBeInTheDocument();
    expect(asked).toEqual(["7", "14"]);
  });

  it("shows extra spend, not a negative saving, when routing cost more than all-smart", async () => {
    server.use(
      http.get(`${ROUTER_URL}/usage`, () =>
        HttpResponse.json({
          windowDays: 7,
          sessions: 4,
          requests: 10,
          costUsd: 15,
          allSmartCostUsd: 12,
          tiers: [
            { tier: "fast", sessions: 4, requests: 10, costUsd: 15 },
            { tier: "normal", sessions: 0, requests: 0, costUsd: 0 },
            { tier: "smart", sessions: 0, requests: 0, costUsd: 0 },
          ],
        } satisfies AutoRoutingUsage),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", {
        name: "What it routed in the last 7 days",
      }),
    );

    const usage = await screen.findByTestId("auto-routing-usage");
    expect(await within(usage).findByText("$3.00")).toBeInTheDocument();
    expect(usage).toHaveTextContent("Extra vs all-smart");
    expect(usage).toHaveTextContent(
      "25% more than sending everything to claude-opus",
    );
    expect(usage).not.toHaveTextContent("-$");
  });

  it("says when nothing went through the router in the window", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", {
        name: "What it routed in the last 7 days",
      }),
    );

    expect(await screen.findByTestId("auto-routing-usage")).toHaveTextContent(
      "No requests went through this router in the last 7 days.",
    );
  });

  it("labels the plan's tier split with the models it was fitted for", async () => {
    const fittedFast = catalogModel(
      "00000000-0000-4000-8000-000000000201",
      "claude-haiku-legacy",
      true,
    );
    const unlisted = "00000000-0000-4000-8000-000000000299";
    settings = makeSettings({
      status: {
        ...makeSettings().status,
        activePlan: { id: PLAN_ID, createdAt: activePlan.createdAt },
      },
    });
    const normal = settings.tiers.normal?.id ?? "";
    server.use(
      http.get(`${API_ORIGIN}/api/llm-models/available`, () =>
        HttpResponse.json([fittedFast]),
      ),
      http.get(`${ROUTER_URL}/plans/${PLAN_ID}`, () =>
        HttpResponse.json({
          ...activePlan,
          tiersFingerprint: fingerprint([fittedFast.dbId, normal, unlisted]),
        }),
      ),
    );
    renderPage();

    expect(
      await screen.findByText(
        "fast · claude-haiku-legacy: 50.0% sessions, 20.0% tokens",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("normal · claude-sonnet: 30.0% sessions, 30.0% tokens"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`smart · ${unlisted}: 20.0% sessions, 50.0% tokens`),
    ).toBeInTheDocument();
  });

  it("shows the plan a save fitted", async () => {
    server.use(
      http.put(ROUTER_URL, () => {
        settings = withActivePlan(makeSettings({ budgetUsdPerDay: 30 }));
        return HttpResponse.json({
          ...settings,
          fit: { status: "active", planId: PLAN_ID },
        } satisfies AutoRoutingSettingsChange);
      }),
    );
    const user = userEvent.setup();
    renderPage();
    const budget = await openConfigure(user);
    await user.clear(budget);
    await user.type(budget, "30");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("$12.50/day")).toBeInTheDocument();
    expect(screen.getByTestId("auto-routing-plan-caption")).toHaveTextContent(
      "Plan updated",
    );
    expect(
      screen.queryByTestId("auto-routing-evaluating"),
    ).not.toBeInTheDocument();
  });
  it("shows the error of a save whose fit failed", async () => {
    const error =
      "ARCHESTRA_ROUTER_INFEASIBLE: cheapest routing costs 8.85889296187498 USD/day, above the 0.01 USD/day budget";
    server.use(
      http.put(ROUTER_URL, () => {
        // The refetch that follows a save reads the router as the server now has it.
        settings = makeSettings({
          status: { ...makeSettings().status, lastFitError: error },
        });
        return HttpResponse.json({
          ...settings,
          fit: { status: "failed", planId: PLAN_ID, error },
        } satisfies AutoRoutingSettingsChange);
      }),
    );
    const user = userEvent.setup();
    renderPage();
    const budget = await openConfigure(user);
    await user.clear(budget);
    await user.type(budget, "25");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Last fit failed")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Budget too low for these models: the cheapest routing costs $8.86/day.",
      ),
    ).toBeInTheDocument();
  });
  it("refuses an infeasible budget, keeping the edited value", async () => {
    const message =
      "Budget too low for these models: the cheapest routing costs $8.86/day.";
    server.use(
      http.put(ROUTER_URL, () =>
        HttpResponse.json(
          { error: { message, type: "api_validation_error" } },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    const budget = await openConfigure(user);
    await user.clear(budget);
    await user.type(budget, "0.01");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(message, expect.anything()),
    );
    expect(budget).toHaveValue(0.01);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("tells when a save found nothing new to plan", async () => {
    server.use(
      http.put(ROUTER_URL, () =>
        HttpResponse.json({
          ...withActivePlan(makeSettings()),
          fit: { status: "unchanged", planId: PLAN_ID },
        } satisfies AutoRoutingSettingsChange),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    const budget = await openConfigure(user);
    await user.clear(budget);
    await user.type(budget, "21");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Plan is up to date"),
    );
  });
});

type AutoRoutingSettingsChange =
  archestraApiTypes.UpdateAutoRouterResponses["200"];

function withActivePlan(base: AutoRouter): AutoRouter {
  return {
    ...base,
    status: {
      ...base.status,
      activePlan: { id: PLAN_ID, createdAt: activePlan.createdAt },
    },
  };
}

describe("past sessions", () => {
  /** A scan this recent is not redone when the Score dialog opens. */
  const fresh = new Date().toISOString();
  const scanned = (
    overrides: Partial<NonNullable<AutoRoutingBackfillState["backfill"]>> = {},
  ): NonNullable<AutoRoutingBackfillState["backfill"]> => ({
    id: "00000000-0000-4000-8000-000000000301",
    status: "scanned",
    phase: "scan",
    windowStart: "2026-09-27T00:00:00.000Z",
    cutoff: fresh,
    eligibleSessions: 240,
    eligibleTokens: 9_000_000,
    breakdown: [
      { apiShape: "messages", client: "anthropic_claude_code", sessions: 200 },
      { apiShape: "chat_completions", client: "opencode", sessions: 40 },
    ],
    scorerCurrent: null,
    maxSessions: null,
    maxCostUsd: null,
    spentCostUsd: 0,
    progress: null,
    error: null,
    completedAt: null,
    awaitingFit: false,
    fitBlockedReason: null,
    ...overrides,
  });
  const job = (
    overrides: Partial<AutoRoutingBackfillState["history"][number]>,
  ): AutoRoutingBackfillState["history"][number] => ({
    id: randomUUID(),
    status: "scanned",
    phase: "scan",
    createdAt: "2026-10-26T09:00:00.000Z",
    completedAt: null,
    startedByName: null,
    foundSessions: 240,
    scoredSessions: null,
    spentCostUsd: 0,
    maxCostUsd: null,
    error: null,
    ...overrides,
  });
  const offer = {
    backfillId: "00000000-0000-4000-8000-000000000301",
    scorerVersionId: "00000000-0000-4000-8000-000000000009",
    windowStart: "2026-09-27T00:00:00.000Z",
    cutoff: "2026-10-26T00:00:00.000Z",
    sessions: 240,
    remaining: 240,
    estimatedCostUsd: 0.24,
    suggestedMaxCostUsd: 1,
    rescore: false,
  };

  /** Serves `states` in turn, the last one from then on. */
  function serveBackfill(
    ...states: [AutoRoutingBackfillState, ...AutoRoutingBackfillState[]]
  ) {
    const scores: unknown[] = [];
    let reads = 0;
    server.use(
      http.get(`${API_ORIGIN}/api/auto-routing/backfill`, () =>
        HttpResponse.json(states[Math.min(reads++, states.length - 1)]),
      ),
      http.post(
        `${API_ORIGIN}/api/auto-routing/backfill/score`,
        async ({ request }) => {
          scores.push(await request.json());
          return HttpResponse.json({
            backfill: scanned({ status: "running", phase: "score" }),
            scoreOffer: null,
            payer: "ready",
            history: [],
          } satisfies AutoRoutingBackfillState);
        },
      ),
    );
    return scores;
  }

  /** Counts the scans the Score dialog starts. */
  function serveScan() {
    const scans = { count: 0 };
    server.use(
      http.post(`${API_ORIGIN}/api/auto-routing/backfill/scan`, () => {
        scans.count++;
        return HttpResponse.json({
          backfill: scanned({ status: "running" }),
          scoreOffer: null,
          payer: "ready",
          history: [],
        } satisfies AutoRoutingBackfillState);
      }),
    );
    return scans;
  }

  /** Clicks the card's Score button and returns the dialog it opens. */
  async function openScore(user: ReturnType<typeof userEvent.setup>) {
    const section = await screen.findByTestId("auto-routing-past-sessions");
    await user.click(
      await within(section).findByRole("button", { name: "Score" }),
    );
    return screen.findByRole("dialog");
  }

  it("counts past sessions when Score opens, even before routing is enabled", async () => {
    settings = makeSettings({ enabled: false, budgetUsdPerDay: null });
    const scans = serveScan();
    const user = userEvent.setup();
    renderPage();

    const section = await screen.findByTestId("auto-routing-past-sessions");
    expect(section).toHaveTextContent("No past sessions counted yet.");
    const dialog = await openScore(user);

    expect(
      await within(dialog).findByText(
        "Looking for past sessions in the interaction log…",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(scans.count).toBe(1));
  });

  it("shows the setup steps while routing is off for the organization", async () => {
    const base = makeSettings();
    const status = {
      ...base.status,
      coldStart: { ...base.status.coldStart, sessions: 1064, required: 1000 },
    };
    settings = makeSettings({ enabled: false, status });
    serveBackfill({
      backfill: scanned({ status: "done" }),
      scoreOffer: null,
      payer: "ready",
      history: [],
    });
    renderPage();

    expect(await screen.findByTestId("auto-routing-setup-2")).toHaveTextContent(
      "Off",
    );
    expect(
      screen.getByRole("link", { name: /Turn it on in Settings/ }),
    ).toHaveAttribute("href", "/settings/llm");
  });

  it("leaves out past sessions for a router that does not learn from them", async () => {
    settings = makeSettings({
      learnFromPastSessions: false,
      readsPastSessions: false,
    });
    renderPage();

    expect(
      await screen.findByTestId("auto-routing-details"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("auto-routing-past-sessions"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("auto-routing-past-sessions-unreadable"),
    ).not.toBeInTheDocument();
  });

  it("explains instead of the card why a router with a custom decision model reads no past sessions", async () => {
    settings = makeSettings({ readsPastSessions: false });
    renderPage();

    expect(
      await screen.findByTestId("auto-routing-past-sessions-unreadable"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("auto-routing-past-sessions"),
    ).not.toBeInTheDocument();
  });

  it("offers scoring past sessions from the evaluating notice while some are left to score", async () => {
    serveBackfill({
      backfill: scanned(),
      scoreOffer: offer,
      payer: "ready",
      history: [],
    });
    const user = userEvent.setup();
    renderPage();

    const notice = await screen.findByTestId("auto-routing-evaluating");
    await user.click(
      await within(notice).findByRole("button", {
        name: "Score past sessions",
      }),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("keeps the dialog the evaluating notice opened while the count it starts hides the notice's action", async () => {
    const stale = scanned({ cutoff: "2026-09-01T00:00:00.000Z" });
    serveBackfill(
      { backfill: stale, scoreOffer: offer, payer: "ready", history: [] },
      {
        backfill: scanned({ status: "running" }),
        scoreOffer: null,
        payer: "ready",
        history: [],
      },
    );
    const scans = serveScan();
    const user = userEvent.setup();
    renderPage();

    const notice = await screen.findByTestId("auto-routing-evaluating");
    await user.click(
      await within(notice).findByRole("button", {
        name: "Score past sessions",
      }),
    );

    await waitFor(() => expect(scans.count).toBe(1));
    await waitFor(() =>
      expect(within(notice).queryByRole("button")).not.toBeInTheDocument(),
    );
    expect(
      within(screen.getByRole("dialog")).getByText(
        "Looking for past sessions in the interaction log…",
      ),
    ).toBeInTheDocument();
  });

  it("offers no scoring from the evaluating notice without a key to pay for it", async () => {
    serveBackfill({
      backfill: scanned(),
      scoreOffer: offer,
      payer: "no_jev_key",
      history: [],
    });
    renderPage();

    await screen.findByTestId("auto-routing-past-sessions");
    expect(
      within(screen.getByTestId("auto-routing-evaluating")).queryByRole(
        "button",
      ),
    ).not.toBeInTheDocument();
  });

  it("follows the count the dialog started even when the read right after it fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let counted = false;
      let failedReads = 0;
      let failing = false;
      server.use(
        http.get(`${API_ORIGIN}/api/auto-routing/backfill`, () => {
          if (failing) {
            failedReads++;
            return HttpResponse.json(
              { error: { message: "unavailable", type: "api_error" } },
              { status: 500 },
            );
          }
          return HttpResponse.json({
            backfill: counted
              ? scanned()
              : scanned({ cutoff: "2026-09-01T00:00:00.000Z" }),
            scoreOffer: offer,
            payer: "ready",
            history: [],
          } satisfies AutoRoutingBackfillState);
        }),
      );
      server.use(
        http.post(`${API_ORIGIN}/api/auto-routing/backfill/scan`, () => {
          failing = true;
          return HttpResponse.json({
            backfill: scanned({ status: "running" }),
            scoreOffer: null,
            payer: "ready",
            history: [],
          } satisfies AutoRoutingBackfillState);
        }),
      );
      const user = userEvent.setup({
        advanceTimers: vi.advanceTimersByTime,
      });
      renderPage();
      await openScore(user);
      await waitFor(() => expect(failedReads).toBeGreaterThan(0));
      counted = true;
      failing = false;

      await vi.advanceTimersByTimeAsync(5_000);

      expect(
        await within(await screen.findByRole("dialog")).findByRole("button", {
          name: "Score 240 sessions",
        }),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers no scoring from the evaluating notice once the sample is scored", async () => {
    serveBackfill({
      backfill: scanned({ status: "done", phase: "score" }),
      scoreOffer: { ...offer, remaining: 0 },
      payer: "ready",
      history: [],
    });
    renderPage();

    await screen.findByTestId("auto-routing-past-sessions");
    expect(
      within(screen.getByTestId("auto-routing-evaluating")).queryByRole(
        "button",
      ),
    ).not.toBeInTheDocument();
  });

  it("drops a fit-blocked notice once a save refits", async () => {
    serveBackfill(
      {
        backfill: scanned({
          status: "done",
          fitBlockedReason: "No daily budget is set.",
        }),
        scoreOffer: null,
        payer: "ready",
        history: [],
      },
      {
        backfill: scanned({ status: "done" }),
        scoreOffer: null,
        payer: "ready",
        history: [],
      },
    );
    server.use(
      http.put(ROUTER_URL, () =>
        HttpResponse.json({
          ...makeSettings(),
          fit: null,
        } satisfies AutoRoutingSettingsChange),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    expect(
      await screen.findByText("No plan is fitted on past sessions"),
    ).toBeInTheDocument();

    const budget = await openConfigure(user);
    await user.clear(budget);
    await user.type(budget, "21");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        screen.queryByText("No plan is fitted on past sessions"),
      ).not.toBeInTheDocument(),
    );
  });

  it("lists what counting and scoring did, newest first, with scoring's cost", async () => {
    serveBackfill({
      backfill: scanned({ status: "running", phase: "score" }),
      scoreOffer: null,
      payer: "ready",
      history: [
        job({
          status: "running",
          phase: "score",
          scoredSessions: 30,
          spentCostUsd: 0.5,
          maxCostUsd: 2,
          startedByName: "Ada",
        }),
        job({
          status: "superseded",
          phase: "score",
          scoredSessions: 120,
          spentCostUsd: 0.12,
        }),
        job({ status: "failed", error: "The interaction log is unreachable." }),
        job({ status: "done", startedByName: "Ada" }),
        job({ status: "done" }),
      ],
    });
    renderPage();

    const history = await screen.findByTestId(
      "auto-routing-past-sessions-history",
    );
    const rows = within(history)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .slice(1)
          .map((cell) => cell.textContent),
      );
    expect(rows).toEqual([
      ["Scoring past sessionsStarted by Ada", "30 scored", "$0.50 of $2.00"],
      [
        "Stopped after 120 sessions: the decision model changed",
        "120",
        "$0.12",
      ],
      ["Counting failedThe interaction log is unreachable.", "240", "Free"],
      ["Found 240 past sessionsStarted by Ada", "240", "Free"],
      [
        "Found 240 past sessionsCounted when routing was turned on",
        "240",
        "Free",
      ],
    ]);
  });

  /** Serves a running scoring job until a Stop for it, then the stopped one; returns the stops. */
  function serveStoppableJob() {
    let state: AutoRoutingBackfillState = {
      backfill: scanned({ status: "running", phase: "score" }),
      scoreOffer: null,
      payer: "ready",
      history: [job({ status: "running", phase: "score", scoredSessions: 30 })],
    };
    const cancels: { id: string; phase: string | null }[] = [];
    server.use(
      http.get(`${API_ORIGIN}/api/auto-routing/backfill`, () =>
        HttpResponse.json(state),
      ),
      http.delete(
        `${API_ORIGIN}/api/auto-routing/backfill/:id`,
        ({ params, request }) => {
          cancels.push({
            id: String(params.id),
            phase: new URL(request.url).searchParams.get("phase"),
          });
          state = {
            backfill: scanned({ status: "cancelled", phase: "score" }),
            scoreOffer: offer,
            payer: "ready",
            history: [
              job({ status: "cancelled", phase: "score", scoredSessions: 30 }),
            ],
          };
          // The organization-level answer; each router's view refetches its own.
          return HttpResponse.json({ ...state, backfill: null });
        },
      ),
    );
    return cancels;
  }

  it("turns Score into Stop while a job runs, and stops it in the phase it shows", async () => {
    settings = withActivePlan(makeSettings());
    const cancels = serveStoppableJob();
    const user = userEvent.setup();
    renderPage();

    const section = await screen.findByTestId("auto-routing-past-sessions");
    expect(
      within(section).queryByRole("button", { name: "Score" }),
    ).not.toBeInTheDocument();
    await user.click(
      await within(section).findByRole("button", { name: "Stop" }),
    );

    expect(
      await within(section).findByRole("button", { name: "Score" }),
    ).toBeEnabled();
    expect(section).toHaveTextContent("Stopped after 30 sessions");
    expect(cancels).toEqual([{ id: scanned().id, phase: "score" }]);
  });

  it("lets a router that reads no past sessions stop the organization's running job", async () => {
    settings = withActivePlan(
      makeSettings({ learnFromPastSessions: false, readsPastSessions: false }),
    );
    const cancels = serveStoppableJob();
    const user = userEvent.setup();
    renderPage();

    const section = await screen.findByTestId("auto-routing-past-sessions");
    await user.click(
      await within(section).findByRole("button", { name: "Stop" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByTestId("auto-routing-past-sessions"),
      ).not.toBeInTheDocument(),
    );
    expect(cancels).toEqual([{ id: scanned().id, phase: "score" }]);
  });

  it("says Up to date, and offers nothing, once every past session is scored", async () => {
    serveBackfill({
      backfill: scanned({ status: "done", phase: "score" }),
      scoreOffer: null,
      payer: "ready",
      history: [job({ status: "done", phase: "score", scoredSessions: 240 })],
    });
    renderPage();

    const section = await screen.findByTestId("auto-routing-past-sessions");
    expect(
      await within(section).findByRole("button", { name: "Up to date" }),
    ).toBeDisabled();
  });

  it.each([
    "cancelled",
    "failed",
  ] as const)("offers Score, and counts again, after a count was %s", async (status) => {
    serveBackfill({
      backfill: scanned({ status }),
      scoreOffer: null,
      payer: "ready",
      history: [job({ status })],
    });
    const scans = serveScan();
    const user = userEvent.setup();
    renderPage();

    const dialog = await openScore(user);

    expect(
      await within(dialog).findByText(
        "Looking for past sessions in the interaction log…",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(scans.count).toBe(1));
  });

  it("totals sessions per client in the dialog, folding agents and the tail", async () => {
    const chain = `${randomUUID()}:${randomUUID()}`;
    serveBackfill({
      backfill: scanned({
        breakdown: [
          {
            apiShape: "messages",
            client: "anthropic_claude_code",
            sessions: 200,
          },
          { apiShape: "messages", client: "anthropic_claude", sessions: 50 },
          { apiShape: "responses", client: "openai_codex", sessions: 120 },
          { apiShape: "responses", client: "kilo", sessions: 60 },
          { apiShape: "chat_completions", client: "kilo", sessions: 20 },
          { apiShape: "responses", client: chain, sessions: 30 },
          { apiShape: "messages", client: randomUUID(), sessions: 5 },
          { apiShape: "responses", client: "opencode", sessions: 25 },
          {
            apiShape: "messages",
            client: "anthropic_claude_desktop",
            sessions: 4,
          },
          { apiShape: "chat_completions", client: "unknown", sessions: 3 },
        ],
      }),
      scoreOffer: offer,
      payer: "ready",
      history: [job({})],
    });
    const user = userEvent.setup();
    renderPage();
    const dialog = await openScore(user);

    const findings = within(dialog).getByTestId("auto-routing-scan-findings");
    expect(
      within(findings)
        .getAllByRole("row")
        .map((row) =>
          within(row)
            .getAllByRole("cell")
            .slice(0, 2)
            .map((cell) => cell.textContent),
        ),
    ).toEqual([
      ["Claude Code", "250"],
      ["Codex", "120"],
      ["Kilo Code", "80"],
      ["Archestra agents", "35"],
      ["OpenCode", "25"],
      ["Other", "7"],
    ]);
  });

  it("accepts a spending limit up to the API's bound and no further", async () => {
    serveBackfill({
      backfill: scanned(),
      scoreOffer: offer,
      payer: "ready",
      history: [],
    });
    const user = userEvent.setup();
    renderPage();
    const dialog = await openScore(user);
    const ceiling = within(dialog).getByLabelText("Spending limit (USD)");
    const action = () =>
      within(dialog).getByRole("button", { name: "Score 240 sessions" });

    await user.clear(ceiling);
    await user.type(ceiling, String(AUTO_ROUTING_BACKFILL_MAX_COST_USD));
    expect(action()).toBeEnabled();
    expect(ceiling).toHaveAttribute("aria-invalid", "false");
    await user.type(ceiling, ".01");
    expect(action()).toBeDisabled();
    expect(ceiling).toHaveAttribute("aria-invalid", "true");
  });

  it("refuses a stale offer, closes the confirmation and offers the current one next", async () => {
    const replaced = "00000000-0000-4000-8000-000000000302";
    let refused = 0;
    serveBackfill(
      { backfill: scanned(), scoreOffer: offer, payer: "ready", history: [] },
      {
        backfill: scanned({ id: replaced }),
        scoreOffer: { ...offer, backfillId: replaced, remaining: 90 },
        payer: "ready",
        history: [],
      },
    );
    server.use(
      http.post(`${API_ORIGIN}/api/auto-routing/backfill/score`, () => {
        refused++;
        return HttpResponse.json(
          { error: { message: "stale", type: "api_conflict_error" } },
          { status: 409 },
        );
      }),
    );
    const user = userEvent.setup();
    renderPage();
    const dialog = await openScore(user);
    await user.click(within(dialog).getByRole("button", { name: /sessions$/ }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(refused).toBe(1);
    expect(
      within(await openScore(user)).getByRole("button", {
        name: "Score 90 sessions",
      }),
    ).toBeInTheDocument();
  });

  it("keeps polling after a backfill until the fit it requested is published", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const done = scanned({ status: "done", phase: "score" });
      let routerReads = 0;
      // Only a read for a router answers whether that router awaits its fit.
      server.use(
        http.get(`${API_ORIGIN}/api/auto-routing/backfill`, ({ request }) => {
          const forRouter = new URL(request.url).searchParams.has("routerId");
          return HttpResponse.json({
            backfill: {
              ...done,
              awaitingFit: forRouter && routerReads++ < 2,
            },
            scoreOffer: null,
            payer: "ready",
            history: [],
          } satisfies AutoRoutingBackfillState);
        }),
      );
      renderPage();
      await screen.findByTestId("auto-routing-past-sessions");
      settings = withActivePlan(makeSettings());

      await vi.advanceTimersByTimeAsync(5_000);
      // The fit has not published yet: nothing re-read the settings.
      expect(screen.queryByText(/Plan updated/)).not.toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await screen.findByText(/Plan updated/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling once the requested fit cannot run, and says why", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reads = 0;
      const blocked: AutoRoutingBackfillState = {
        backfill: scanned({
          status: "done",
          phase: "score",
          fitBlockedReason: "No daily budget is set.",
        }),
        scoreOffer: null,
        payer: "ready",
        history: [],
      };
      server.use(
        http.get(`${API_ORIGIN}/api/auto-routing/backfill`, () => {
          reads++;
          return HttpResponse.json(blocked);
        }),
      );
      renderPage();
      const section = await screen.findByTestId("auto-routing-past-sessions");

      await vi.advanceTimersByTimeAsync(15_000);

      expect(reads).toBe(1);
      expect(section).toHaveTextContent("No daily budget is set.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("confirms the window of the scan it submits, not the newest job's", async () => {
    const older = "00000000-0000-4000-8000-000000000303";
    const scores = serveBackfill({
      backfill: scanned({
        status: "cancelled",
        windowStart: "2026-10-20T00:00:00.000Z",
      }),
      scoreOffer: {
        ...offer,
        backfillId: older,
        windowStart: "2026-08-01T00:00:00.000Z",
        cutoff: "2026-09-01T00:00:00.000Z",
      },
      payer: "ready",
      history: [],
    });
    const user = userEvent.setup();
    renderPage();
    const dialog = await openScore(user);

    expect(dialog).toHaveTextContent(
      `${formatDate({ date: "2026-08-01T00:00:00.000Z", dateFormat: "MMM d, yyyy" })} to ${formatDate({ date: "2026-09-01T00:00:00.000Z", dateFormat: "MMM d, yyyy" })}`,
    );
    // The newest job's findings describe another scan, so they stay out.
    expect(
      within(dialog).queryByTestId("auto-routing-scan-findings"),
    ).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /sessions$/ }));
    await waitFor(() => expect(scores).toMatchObject([{ backfillId: older }]));
  });

  it("scores only after the confirmation, with the ceiling the admin set", async () => {
    const scores = serveBackfill({
      backfill: scanned(),
      scoreOffer: offer,
      payer: "ready",
      history: [],
    });
    const user = userEvent.setup();
    renderPage();
    const dialog = await openScore(user);
    expect(dialog).toHaveTextContent("sends the opening prompt");
    expect(dialog).toHaveTextContent("~$");
    expect(scores).toEqual([]);
    const ceiling = within(dialog).getByLabelText("Spending limit (USD)");
    await user.clear(ceiling);
    await user.type(ceiling, "2.5");
    await user.click(within(dialog).getByRole("button", { name: /sessions$/ }));

    await waitFor(() =>
      expect(scores).toEqual([
        {
          backfillId: offer.backfillId,
          scorerVersionId: offer.scorerVersionId,
          maxSessions: 240,
          maxCostUsd: 2.5,
        },
      ]),
    );
  });

  it("says past sessions need scoring again beside an active plan once the scorer changed", async () => {
    settings = withActivePlan(makeSettings());
    const scores = serveBackfill({
      backfill: scanned({
        status: "superseded",
        phase: "score",
        scorerCurrent: false,
      }),
      scoreOffer: { ...offer, rescore: true },
      payer: "ready",
      history: [],
    });
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByText("Past sessions need scoring again"),
    ).toBeInTheDocument();
    const dialog = await openScore(user);
    expect(dialog).toHaveTextContent("Re-score past sessions?");
    await user.click(
      within(dialog).getByRole("button", { name: "Re-score 240 sessions" }),
    );

    await waitFor(() =>
      expect(scores).toEqual([
        {
          backfillId: offer.backfillId,
          scorerVersionId: offer.scorerVersionId,
          maxSessions: 240,
          maxCostUsd: 1,
        },
      ]),
    );
  });

  it("points to the Jev key instead of offering a score the scorer cannot run", async () => {
    settings = makeSettings({
      status: {
        ...makeSettings().status,
        scorer: "no_jev_key",
        scorerApiKey: null,
      },
    });
    serveBackfill({
      backfill: scanned(),
      scoreOffer: offer,
      payer: "no_jev_key",
      history: [],
    });
    renderPage();

    const section = await screen.findByTestId("auto-routing-past-sessions");
    expect(
      within(section).getByTestId("auto-routing-add-jev-key"),
    ).toHaveAttribute(
      "href",
      "/llm/model-providers?create=jev&access=organization",
    );
    expect(
      within(section).queryByRole("button", { name: /^Score/ }),
    ).not.toBeInTheDocument();
    // The past sessions and the setup step both point to it.
    expect(screen.getAllByTestId("auto-routing-add-jev-key")).toHaveLength(2);
    expect(
      screen.queryByPlaceholderText("A first message of a session"),
    ).not.toBeInTheDocument();
  });

  it("offers no score the organization's Jev key cannot pay for, even when the router's decision key works", async () => {
    settings = withActivePlan(makeSettings());
    serveBackfill({
      backfill: scanned(),
      scoreOffer: offer,
      payer: "no_jev_key",
      history: [],
    });
    renderPage();

    const section = await screen.findByTestId("auto-routing-past-sessions");
    expect(
      await within(section).findByTestId("auto-routing-add-jev-key"),
    ).toBeInTheDocument();
    expect(
      within(section).queryByRole("button", { name: /^Score/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps the card beside an active plan and scores from it in one step", async () => {
    settings = withActivePlan(makeSettings());
    const scores = serveBackfill({
      backfill: scanned(),
      scoreOffer: offer,
      payer: "ready",
      history: [job({})],
    });
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByTestId("auto-routing-figures"),
    ).toBeInTheDocument();
    const dialog = await openScore(user);
    expect(
      within(dialog).getByTestId("auto-routing-scan-findings"),
    ).toHaveTextContent("240 past sessions found");
    await user.click(
      within(dialog).getByRole("button", { name: "Score 240 sessions" }),
    );

    await waitFor(() =>
      expect(scores).toEqual([
        {
          backfillId: offer.backfillId,
          scorerVersionId: offer.scorerVersionId,
          maxSessions: 240,
          maxCostUsd: 1,
        },
      ]),
    );
  });

  it("counts past sessions again when Score opens on a stale scan", async () => {
    settings = withActivePlan(makeSettings());
    serveBackfill({
      backfill: scanned({ status: "done", cutoff: "2026-10-26T00:00:00.000Z" }),
      scoreOffer: null,
      payer: "ready",
      history: [job({ status: "done" })],
    });
    const scans = serveScan();
    const user = userEvent.setup();
    renderPage();

    const dialog = await openScore(user);

    expect(
      await within(dialog).findByText(
        "Looking for past sessions in the interaction log…",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(scans.count).toBe(1));
  });

  it("shows read-only viewers the history without the Score button", async () => {
    setCanUpdate(false);
    serveBackfill({
      backfill: scanned(),
      scoreOffer: offer,
      payer: "ready",
      history: [job({ status: "done" })],
    });
    renderPage();

    const section = await screen.findByTestId("auto-routing-past-sessions");
    expect(
      await within(section).findByTestId("auto-routing-past-sessions-history"),
    ).toHaveTextContent("Found 240 past sessions");
    expect(within(section).queryByRole("button")).not.toBeInTheDocument();
  });
});

function setCanUpdate(canUpdate: boolean) {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: canUpdate,
    isPending: false,
  } as unknown as ReturnType<typeof useHasPermissions>);
}

/** A fit on the saved tiers over 10M tokens and 150 sessions a day, shown at ×3. */
function feasibleSimulation(quality: number): AutoRoutingSimulation {
  const saved = makeSettings().tiers;
  return {
    status: "feasible",
    budgetUsdPerDay: 20,
    summary: {
      ...activePlan.summary,
      tokens_per_day: 30_000_000,
      sessions_per_day: 450,
      expected_spend: 20,
      value_size_weighted: quality,
    },
    tiersFingerprint: fingerprint([
      saved.fast?.id ?? "",
      saved.normal?.id ?? "",
      saved.smart?.id ?? "",
    ]),
    baseline: { tokensPerDay: 10_000_000, sessionsPerDay: 150 },
  };
}

function fingerprint(modelIds: string[]) {
  const prices = { input: 1, cache_read: 0.1, cache_write: 1.25, output: 5 };
  return {
    tiers: modelIds.map((model_id) => ({
      model_id,
      short: prices,
      long: null,
    })),
    long_context_threshold: null,
  };
}

/** The Overview, with the layout's Configure button beside it. */
function renderPage(sibling?: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AutoRouterIdContext.Provider value={ROUTER_ID}>
        <ConfigureAutoRoutingButton />
        <AutoRoutingOverviewPage />
        {sibling}
      </AutoRouterIdContext.Provider>
    </QueryClientProvider>,
  );
}

/** Opens the Configure dialog and returns its budget input. */
async function openConfigure(user: ReturnType<typeof userEvent.setup>) {
  const [configure] = await screen.findAllByRole("button", {
    name: "Configure",
  });
  await user.click(configure);
  return screen.findByLabelText("USD per day");
}
