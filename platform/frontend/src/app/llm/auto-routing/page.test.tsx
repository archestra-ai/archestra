import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
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
import type {
  AutoRoutingPlanDetail,
  AutoRoutingPreview,
  AutoRoutingSettings,
  AutoRoutingSettingsUpdate,
} from "@/lib/auto-routing.query";
import type { LlmModel } from "@/lib/llm-models.query";
import { useOrganization } from "@/lib/organization.query";
import AutoRoutingOverviewPage from "./page";
import AutoRoutingPlansPage from "./plans/page";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("sonner");

const API_ORIGIN = "http://localhost:9000";
const PLAN_ID = "00000000-0000-4000-8000-000000000001";

const tier = (modelId: string, index: number) => ({
  id: `00000000-0000-4000-8000-00000000010${index}`,
  provider: "anthropic" as const,
  modelId,
});

function makeSettings(
  overrides: Partial<AutoRoutingSettings> = {},
): AutoRoutingSettings {
  return {
    enabled: true,
    budgetUsdPerDay: 20,
    tiers: {
      fast: tier("claude-haiku", 1),
      normal: tier("claude-sonnet", 2),
      smart: tier("claude-opus", 3),
    },
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
    value_per_usd: 0.002,
  },
  diagnostics: { holdout: { status: "insufficient_history" } },
  error: null,
  decisionCount: 420,
  tiersFingerprint: {},
  plan: null,
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
      recommendedForAgents: null,
      pricePerMillionInput: null,
      pricePerMillionOutput: null,
      isCustomPrice: false,
      priceSource: "default",
      pricePerMillionCacheRead: null,
      pricePerMillionCacheWrite: null,
      cachePriceSource: "default",
    },
  };
}

let settings: AutoRoutingSettings;
const updates: AutoRoutingSettingsUpdate[] = [];

const server = setupServer(
  http.get(`${API_ORIGIN}/api/auto-routing/settings`, () =>
    HttpResponse.json(settings),
  ),
  http.put(`${API_ORIGIN}/api/auto-routing/settings`, async ({ request }) => {
    updates.push((await request.json()) as AutoRoutingSettingsUpdate);
    return HttpResponse.json({ ...settings, fit: null });
  }),
  http.get(`${API_ORIGIN}/api/auto-routing/plans/${PLAN_ID}`, () =>
    HttpResponse.json(activePlan),
  ),
  http.get(`${API_ORIGIN}/api/llm-models/available`, () =>
    HttpResponse.json([]),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});

beforeEach(() => {
  settings = makeSettings();
  updates.length = 0;
  setCanUpdate(true);
  vi.mocked(useOrganization).mockReturnValue({
    data: null,
  } as unknown as ReturnType<typeof useOrganization>);
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("AutoRoutingOverviewPage", () => {
  it("saves only the edited budget", async () => {
    const user = userEvent.setup();
    renderPage();
    const budget = await screen.findByLabelText("Daily budget (USD)");
    await user.clear(budget);
    await user.type(budget, "55.5");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updates).toEqual([{ budgetUsdPerDay: 55.5 }]));
  });

  it("saves a tier change while disabled routing has no budget", async () => {
    settings = makeSettings({ enabled: false, budgetUsdPerDay: null });
    const toolModel = catalogModel(
      "00000000-0000-4000-8000-000000000201",
      "claude-haiku-next",
      true,
    );
    server.use(
      http.get(`${API_ORIGIN}/api/llm-models/available`, () =>
        HttpResponse.json([toolModel]),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText("Daily budget (USD)");
    const [fastTier] = screen.getAllByRole("combobox");
    await user.click(fastTier);
    await user.click(await screen.findByText("claude-haiku-next"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updates).toEqual([{ fastModelId: toolModel.dbId }]),
    );
  });

  it("keeps an unsaved budget edit across a settings refresh, then shows the saved value", async () => {
    server.use(
      http.post(`${API_ORIGIN}/api/auto-routing/replan`, () =>
        HttpResponse.json({
          ...makeSettings({
            status: {
              ...makeSettings().status,
              coldStart: { ...makeSettings().status.coldStart, sessions: 13 },
            },
          }),
          fit: null,
        } satisfies AutoRoutingSettingsChange),
      ),
      http.put(
        `${API_ORIGIN}/api/auto-routing/settings`,
        async ({ request }) => {
          const body = (await request.json()) as AutoRoutingSettingsUpdate;
          updates.push(body);
          return HttpResponse.json({
            ...makeSettings({ budgetUsdPerDay: body.budgetUsdPerDay }),
            fit: null,
          } satisfies AutoRoutingSettingsChange);
        },
      ),
    );
    const user = userEvent.setup();
    renderPage();
    const budget = await screen.findByLabelText("Daily budget (USD)");
    await user.clear(budget);
    await user.type(budget, "55.5");
    await user.click(screen.getByRole("button", { name: "Re-plan now" }));

    await waitFor(() =>
      expect(screen.getByTestId("auto-routing-status")).toHaveTextContent(
        "13 of 100",
      ),
    );
    expect(budget).toHaveValue(55.5);

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updates).toEqual([{ budgetUsdPerDay: 55.5 }]));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(),
    );
    expect(budget).toHaveValue(55.5);
  });

  it("offers a retry when the settings fail to load", async () => {
    let fail = true;
    server.use(
      http.get(`${API_ORIGIN}/api/auto-routing/settings`, () =>
        fail
          ? HttpResponse.json(
              { error: { message: "Unavailable" } },
              { status: 500 },
            )
          : HttpResponse.json(settings),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(
      screen.queryByLabelText("Daily budget (USD)"),
    ).not.toBeInTheDocument();

    fail = false;
    await user.click(retry);

    expect(await screen.findByLabelText("Daily budget (USD)")).toHaveValue(20);
  });

  it("requires a budget to enable routing", async () => {
    settings = makeSettings({ enabled: false, budgetUsdPerDay: null });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("switch", { name: "Enabled" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Set a daily budget")).toBeInTheDocument();
    expect(updates).toEqual([]);
  });

  it("offers only tool-capable models as tiers, keeping a saved one shown", async () => {
    const savedFast = makeSettings().tiers.fast;
    server.use(
      http.get(`${API_ORIGIN}/api/llm-models/available`, () =>
        HttpResponse.json([
          catalogModel(savedFast?.id ?? "", "claude-haiku", false),
          catalogModel(
            "00000000-0000-4000-8000-000000000201",
            "claude-sonnet-next",
            true,
          ),
          catalogModel(
            "00000000-0000-4000-8000-000000000202",
            "text-only-model",
            false,
          ),
        ]),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText("Daily budget (USD)");
    const [, normalTier] = screen.getAllByRole("combobox");
    await user.click(normalTier);

    expect(await screen.findByText("claude-sonnet-next")).toBeInTheDocument();
    expect(screen.queryByText("text-only-model")).not.toBeInTheDocument();
    expect(screen.getAllByText("claude-haiku").length).toBeGreaterThan(0);
  });

  it("rejects a budget below a cent without saving", async () => {
    const user = userEvent.setup();
    renderPage();
    const budget = await screen.findByLabelText("Daily budget (USD)");
    await user.clear(budget);
    await user.type(budget, "0");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(/Enter an amount between 0.01/),
    ).toBeInTheDocument();
    expect(updates).toEqual([]);
  });

  it("shows read-only viewers the settings without letting them change anything", async () => {
    setCanUpdate(false);
    renderPage();

    expect(await screen.findByLabelText("Daily budget (USD)")).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Enabled" })).toBeDisabled();
    expect(screen.getByLabelText("Try a prompt")).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Re-plan now" }),
    ).not.toBeInTheDocument();
  });

  it("reports cold-start progress while no plan is active", async () => {
    renderPage();

    expect(await screen.findByTestId("auto-routing-status")).toHaveTextContent(
      "Cold start: 12 of 100 sessions",
    );
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
    expect(screen.getByText("+2.0 pp")).toBeInTheDocument();
    expect(screen.getByTestId("auto-routing-status")).toHaveTextContent(
      "Active plan from",
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
      http.get(`${API_ORIGIN}/api/auto-routing/plans/${PLAN_ID}`, () =>
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

  it("shows the plan a save fitted without refetching the settings", async () => {
    let settingsReads = 0;
    let plans: AutoRoutingPlanDetail[] = [];
    server.use(
      http.get(`${API_ORIGIN}/api/auto-routing/settings`, () => {
        settingsReads++;
        return HttpResponse.json(settings);
      }),
      http.put(`${API_ORIGIN}/api/auto-routing/settings`, () => {
        plans = [activePlan];
        return HttpResponse.json({
          ...withActivePlan(makeSettings({ budgetUsdPerDay: 30 })),
          fit: { status: "active", planId: PLAN_ID },
        } satisfies AutoRoutingSettingsChange);
      }),
      http.get(`${API_ORIGIN}/api/auto-routing/plans`, () =>
        HttpResponse.json(plans),
      ),
    );
    const user = userEvent.setup();
    renderPage(<AutoRoutingPlansPage />);
    expect(await screen.findByText("No plans yet")).toBeInTheDocument();
    const budget = screen.getByLabelText("Daily budget (USD)");
    await user.clear(budget);
    await user.type(budget, "30");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("$12.50/day")).toBeInTheDocument();
    expect(screen.getByTestId("auto-routing-status")).toHaveTextContent(
      "Active plan from",
    );
    expect(await screen.findByText("420")).toBeInTheDocument();
    expect(settingsReads).toBe(1);
  });

  it("shows the error of a re-plan whose fit failed", async () => {
    const error = "ARCHESTRA_ROUTER_INFEASIBLE: budget below the cheapest tier";
    server.use(
      http.post(`${API_ORIGIN}/api/auto-routing/replan`, () =>
        HttpResponse.json({
          ...makeSettings({
            status: { ...makeSettings().status, lastFitError: error },
          }),
          fit: { status: "failed", planId: PLAN_ID, error },
        } satisfies AutoRoutingSettingsChange),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Re-plan now" }),
    );

    expect(await screen.findByText("Last fit failed")).toBeInTheDocument();
    expect(screen.getByText(error)).toBeInTheDocument();
  });

  it("previews the tier a prompt would get", async () => {
    const previewed: unknown[] = [];
    server.use(
      http.post(
        `${API_ORIGIN}/api/auto-routing/preview`,
        async ({ request }) => {
          previewed.push(await request.json());
          return HttpResponse.json({
            tierNeeded: [0.1, 0.2, 0.7],
            pLong: 0.25,
            reason: "planned",
            planId: PLAN_ID,
            chosen: { tier: "smart", model: tier("claude-opus", 3) },
            propensity: 0.6,
            expectedCostUsd: 0.42,
            scorerCostUsd: 0.000123,
          } satisfies AutoRoutingPreview);
        },
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(
      await screen.findByLabelText("Try a prompt"),
      "Refactor the billing module",
    );
    await user.click(screen.getByRole("button", { name: "Preview" }));

    const result = await screen.findByTestId("auto-routing-preview");
    expect(previewed).toEqual([
      { text: "Refactor the billing module", kind: "main" },
    ]);
    expect(result).toHaveTextContent("smart");
    expect(result).toHaveTextContent("anthropic/claude-opus");
    expect(within(result).getByText("70.0%")).toBeInTheDocument();
    expect(within(result).getByText("25.0%")).toBeInTheDocument();
    expect(within(result).getByText("$0.000123")).toBeInTheDocument();
  });
});

type AutoRoutingSettingsChange =
  archestraApiTypes.UpdateAutoRoutingSettingsResponses["200"];

function withActivePlan(base: AutoRoutingSettings): AutoRoutingSettings {
  return {
    ...base,
    status: {
      ...base.status,
      activePlan: { id: PLAN_ID, createdAt: activePlan.createdAt },
    },
  };
}

function setCanUpdate(canUpdate: boolean) {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: canUpdate,
    isPending: false,
  } as unknown as ReturnType<typeof useHasPermissions>);
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

function renderPage(sibling?: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AutoRoutingOverviewPage />
      {sibling}
    </QueryClientProvider>,
  );
}
