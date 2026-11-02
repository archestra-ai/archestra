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
import type {
  AutoRoutingBackfillState,
  AutoRoutingPlanDetail,
  AutoRoutingPreview,
  AutoRoutingSettings,
  AutoRoutingSettingsUpdate,
  AutoRoutingSimulation,
} from "@/lib/auto-routing.query";
import type { LlmModel } from "@/lib/llm-models.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import { formatDate } from "@/lib/utils/date-time";
import AutoRoutingOverviewPage from "./page";
import AutoRoutingPlansPage from "./plans/page";

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
    routedAgentCount: 2,
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
      mediaPricing: null,
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
  http.get(`${API_ORIGIN}/api/auto-routing/backfill`, () =>
    HttpResponse.json({
      backfill: null,
      scoreOffer: null,
    } satisfies AutoRoutingBackfillState),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});

beforeEach(() => {
  vi.clearAllMocks();
  settings = makeSettings();
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
  it("saves only the edited budget", async () => {
    const user = userEvent.setup();
    renderPage();
    const budget = await screen.findByLabelText("Daily budget (USD)");
    await user.clear(budget);
    await user.type(budget, "55.5");
    await user.click(screen.getByRole("button", { name: "Save and re-plan" }));

    await waitFor(() => expect(updates).toEqual([{ budgetUsdPerDay: 55.5 }]));
  });

  it("re-plans on the saved settings while the form is clean", async () => {
    let replans = 0;
    server.use(
      http.post(`${API_ORIGIN}/api/auto-routing/replan`, () => {
        replans += 1;
        return HttpResponse.json({
          ...makeSettings(),
          fit: null,
        } satisfies AutoRoutingSettingsChange);
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Re-plan now" }),
    );

    await waitFor(() => expect(replans).toBe(1));
    expect(updates).toEqual([]);
  });

  it("turns the action into a save while edited, then back into a re-plan", async () => {
    let replans = 0;
    server.use(
      http.post(`${API_ORIGIN}/api/auto-routing/replan`, () => {
        replans += 1;
        return HttpResponse.json({
          ...makeSettings(),
          fit: null,
        } satisfies AutoRoutingSettingsChange);
      }),
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
    expect(
      screen.queryByRole("button", { name: "Re-plan now" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save and re-plan" }));

    await waitFor(() => expect(updates).toEqual([{ budgetUsdPerDay: 55.5 }]));
    expect(
      await screen.findByRole("button", { name: "Re-plan now" }),
    ).toBeEnabled();
    expect(budget).toHaveValue(55.5);
    expect(replans).toBe(0);
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
    await user.click(await screen.findByRole("switch", { name: "Disabled" }));
    await user.click(screen.getByRole("button", { name: "Save and re-plan" }));

    expect(await screen.findByText("Set a daily budget")).toBeInTheDocument();
    expect(updates).toEqual([]);
  });

  it("counts the agents on the organization default that routing applies to", async () => {
    settings = makeSettings({ routedAgentCount: 7 });
    renderPage();

    expect(await screen.findByText(/\b7 agents\b/)).toBeInTheDocument();
  });

  it("shows the organization trio read-only, with a link to edit it", async () => {
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
    await screen.findByLabelText("Daily budget (USD)");

    const tierValue = (label: string) =>
      screen.getByText(label).closest("div")?.querySelector("dd");
    await waitFor(() =>
      expect(tierValue("Fast model")).toHaveTextContent("Claude Haiku"),
    );
    expect(tierValue("Normal model")).toHaveTextContent("claude-sonnet");
    expect(tierValue("Smart model")).toHaveTextContent("Not set");
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(
      screen.getByRole("link", { name: /Settings → Agents/ }),
    ).toHaveAttribute("href", "/settings/agents");
  });

  it("rejects a budget below a cent without saving", async () => {
    const user = userEvent.setup();
    renderPage();
    const budget = await screen.findByLabelText("Daily budget (USD)");
    await user.clear(budget);
    await user.type(budget, "0");
    await user.click(screen.getByRole("button", { name: "Save and re-plan" }));

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
      screen.queryByRole("button", { name: "Save and re-plan" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Re-plan now" }),
    ).not.toBeInTheDocument();
  });

  it("reports cold-start progress while no plan is active", async () => {
    renderPage();

    expect(await screen.findByTestId("auto-routing-status")).toHaveTextContent(
      "Cold start · 12 of 100 sessions scored",
    );
  });

  it("leaves cold start once enough sessions are scored, while the first fit is pending", async () => {
    const base = makeSettings();
    settings = makeSettings({
      status: {
        ...base.status,
        coldStart: { ...base.status.coldStart, sessions: 1064, required: 1000 },
      },
    });
    renderPage();

    expect(await screen.findByTestId("auto-routing-status")).toHaveTextContent(
      "Fitting the first plan · 1,064 sessions scored, enough for a plan",
    );
  });

  it("does not claim a fit is coming after the last one failed", async () => {
    const base = makeSettings();
    settings = makeSettings({
      status: {
        ...base.status,
        coldStart: { ...base.status.coldStart, sessions: 1064, required: 1000 },
        lastFitError: "fit exploded",
      },
    });
    renderPage();

    expect(await screen.findByTestId("auto-routing-status")).toHaveTextContent(
      "No plan yet · 1,064 sessions scored",
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
    expect(screen.getByText("+2.0 points")).toBeInTheDocument();
    expect(screen.getByTestId("auto-routing-status")).toHaveTextContent(
      "Active plan",
    );
  });

  it("simulates a traffic change on the active plan without saving", async () => {
    settings = withActivePlan(makeSettings());
    const simulated: unknown[] = [];
    server.use(
      http.post(
        `${API_ORIGIN}/api/auto-routing/simulate`,
        async ({ request }) => {
          simulated.push(await request.json());
          return HttpResponse.json(feasibleSimulation(0.71));
        },
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByLabelText("Traffic"));
    await user.click(await screen.findByRole("option", { name: "×3" }));

    const whatIf = screen.getByTestId("auto-routing-what-if");
    expect(await within(whatIf).findByText("71.0%")).toBeInTheDocument();
    expect(within(whatIf).getByText("$20.00/day")).toBeInTheDocument();
    expect(whatIf).toHaveTextContent(
      "30M tokens/day, 450 sessions/day (now 10M tokens/day, 150 sessions/day)",
    );
    expect(simulated).toEqual([{ budgetUsdPerDay: 20, volumeMultiplier: 3 }]);
    expect(updates).toEqual([]);
  });

  it("labels the simulated tier split with the models the simulation fitted", async () => {
    settings = withActivePlan(makeSettings());
    server.use(
      http.post(`${API_ORIGIN}/api/auto-routing/simulate`, () =>
        HttpResponse.json(feasibleSimulation(0.71)),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByLabelText("Traffic"));
    await user.click(await screen.findByRole("option", { name: "×3" }));

    const whatIf = screen.getByTestId("auto-routing-what-if");
    expect(
      await within(whatIf).findByText(
        "fast · claude-haiku: 50.0% sessions, 20.0% tokens",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("fast · unknown: 50.0% sessions, 20.0% tokens"),
    ).toBeInTheDocument();
  });

  it("shows a result only for the current inputs", async () => {
    settings = withActivePlan(makeSettings());
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post(
        `${API_ORIGIN}/api/auto-routing/simulate`,
        async ({ request }) => {
          const body = (await request.json()) as { volumeMultiplier: number };
          if (body.volumeMultiplier === 5) await held;
          return HttpResponse.json(
            feasibleSimulation(body.volumeMultiplier === 5 ? 0.6 : 0.71),
          );
        },
      ),
    );
    const user = userEvent.setup();
    renderPage();
    const whatIf = await screen.findByTestId("auto-routing-what-if");
    await user.click(within(whatIf).getByLabelText("Traffic"));
    await user.click(await screen.findByRole("option", { name: "×3" }));
    expect(await within(whatIf).findByText("71.0%")).toBeInTheDocument();

    await user.click(within(whatIf).getByLabelText("Traffic"));
    await user.click(await screen.findByRole("option", { name: "×5" }));

    expect(await within(whatIf).findByText("Simulating…")).toBeInTheDocument();
    expect(within(whatIf).queryByText("71.0%")).not.toBeInTheDocument();
    release();
    expect(await within(whatIf).findByText("60.0%")).toBeInTheDocument();

    await user.clear(within(whatIf).getByLabelText("Budget (USD/day)"));

    expect(within(whatIf).queryByText("60.0%")).not.toBeInTheDocument();
    expect(within(whatIf).queryByText("Simulating…")).not.toBeInTheDocument();
  });

  it("retries a simulation refused while an earlier one finishes", async () => {
    settings = withActivePlan(makeSettings());
    let calls = 0;
    server.use(
      http.post(`${API_ORIGIN}/api/auto-routing/simulate`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(
              {
                error: {
                  message: "A simulation is already running",
                  type: "api_rate_limit_error",
                },
              },
              { status: 429 },
            )
          : HttpResponse.json(feasibleSimulation(0.71));
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByLabelText("Traffic"));
    await user.click(await screen.findByRole("option", { name: "×3" }));

    const whatIf = screen.getByTestId("auto-routing-what-if");
    expect(
      await within(whatIf).findByText("71.0%", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it("reports the minimum budget when the simulated traffic cannot be afforded", async () => {
    settings = withActivePlan(makeSettings());
    server.use(
      http.post(`${API_ORIGIN}/api/auto-routing/simulate`, () =>
        HttpResponse.json({
          status: "infeasible",
          minBudgetUsdPerDay: 31.4,
          baseline: { tokensPerDay: 10_000_000, sessionsPerDay: 150 },
        } satisfies AutoRoutingSimulation),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByLabelText("Traffic"));
    await user.click(await screen.findByRole("option", { name: "×10" }));

    expect(
      await within(screen.getByTestId("auto-routing-what-if")).findByText(
        "$31.40/day",
      ),
    ).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Save and re-plan" }));

    expect(await screen.findByText("$12.50/day")).toBeInTheDocument();
    expect(screen.getByTestId("auto-routing-status")).toHaveTextContent(
      "Active plan",
    );
    expect(await screen.findByText("420")).toBeInTheDocument();
    expect(settingsReads).toBe(1);
  });

  it("shows the error of a re-plan whose fit failed", async () => {
    const error =
      "ARCHESTRA_ROUTER_INFEASIBLE: cheapest routing costs 8.85889296187498 USD/day, above the 0.01 USD/day budget";
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
    expect(
      screen.getByText(
        "Budget too low for these models: the cheapest routing costs $8.86/day.",
      ),
    ).toBeInTheDocument();
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
    expect(previewed).toEqual([{ text: "Refactor the billing module" }]);
    expect(result).toHaveTextContent("smart");
    expect(result).toHaveTextContent("anthropic/claude-opus");
    expect(within(result).getByText("70.0%")).toBeInTheDocument();
    expect(within(result).getByText("25.0%")).toBeInTheDocument();
    expect(within(result).getByText("$0.000123")).toBeInTheDocument();
    expect(within(result).getByText("$0.42")).toBeInTheDocument();
  });

  it("refuses an infeasible budget, keeping the edited value", async () => {
    const message =
      "Budget too low for these models: the cheapest routing costs $8.86/day.";
    server.use(
      http.put(`${API_ORIGIN}/api/auto-routing/settings`, () =>
        HttpResponse.json(
          { error: { message, type: "api_validation_error" } },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    const budget = await screen.findByLabelText("Daily budget (USD)");
    await user.clear(budget);
    await user.type(budget, "0.01");
    await user.click(screen.getByRole("button", { name: "Save and re-plan" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(message, expect.anything()),
    );
    expect(budget).toHaveValue(0.01);
    expect(
      screen.getByRole("button", { name: "Save and re-plan" }),
    ).toBeEnabled();
  });

  it("keeps the slider range from the saved budget while a new one is typed", async () => {
    const user = userEvent.setup();
    renderPage();
    const budget = await screen.findByLabelText("Daily budget (USD)");
    const slider = screen.getByRole("slider");

    for (const typed of ["50", "80"]) {
      await user.clear(budget);
      await user.type(budget, typed);
      expect(slider).toHaveAttribute("aria-valuenow", typed);
      expect(slider).toHaveAttribute("aria-valuemax", "100");
    }
  });

  it("tells when a re-plan found nothing new", async () => {
    server.use(
      http.post(`${API_ORIGIN}/api/auto-routing/replan`, () =>
        HttpResponse.json({
          ...withActivePlan(makeSettings()),
          fit: { status: "unchanged", planId: PLAN_ID },
        } satisfies AutoRoutingSettingsChange),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Re-plan now" }),
    );

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Plan is up to date"),
    );
  });

  it("offers a plain save when routing is switched off", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("switch", { name: "Enabled" }));

    expect(screen.getByRole("switch", { name: "Disabled" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updates).toEqual([{ enabled: false }]));
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

describe("past sessions", () => {
  const scanned = (
    overrides: Partial<NonNullable<AutoRoutingBackfillState["backfill"]>> = {},
  ): NonNullable<AutoRoutingBackfillState["backfill"]> => ({
    id: "00000000-0000-4000-8000-000000000301",
    status: "scanned",
    phase: "scan",
    windowStart: "2026-09-27T00:00:00.000Z",
    cutoff: "2026-10-26T00:00:00.000Z",
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
          } satisfies AutoRoutingBackfillState);
        },
      ),
    );
    return scores;
  }

  it("scans past traffic before routing is enabled", async () => {
    settings = makeSettings({ enabled: false, budgetUsdPerDay: null });
    let scans = 0;
    server.use(
      http.post(`${API_ORIGIN}/api/auto-routing/backfill/scan`, () => {
        scans++;
        return HttpResponse.json({
          backfill: scanned({ status: "running" }),
          scoreOffer: null,
        } satisfies AutoRoutingBackfillState);
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Scan past sessions" }),
    );

    await waitFor(() => expect(scans).toBe(1));
  });

  it("says routing is off once enough sessions are scored, and fits once enabled", async () => {
    const base = makeSettings();
    const status = {
      ...base.status,
      coldStart: { ...base.status.coldStart, sessions: 1064, required: 1000 },
    };
    settings = makeSettings({ enabled: false, status });
    serveBackfill({ backfill: scanned({ status: "done" }), scoreOffer: null });
    server.use(
      http.put(`${API_ORIGIN}/api/auto-routing/settings`, () =>
        HttpResponse.json({
          ...makeSettings({ enabled: true, status }),
          fit: null,
        } satisfies AutoRoutingSettingsChange),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByTestId("auto-routing-status")).toHaveTextContent(
      "Auto routing is off · 1,064 sessions scored, enough for a plan",
    );

    await user.click(screen.getByRole("switch", { name: "Disabled" }));
    await user.click(screen.getByRole("button", { name: "Save and re-plan" }));

    await waitFor(() =>
      expect(screen.getByTestId("auto-routing-status")).toHaveTextContent(
        "Fitting the first plan",
      ),
    );
  });

  it("drops a fit-blocked notice once a re-plan refits", async () => {
    serveBackfill(
      {
        backfill: scanned({
          status: "done",
          fitBlockedReason: "No daily budget is set.",
        }),
        scoreOffer: null,
      },
      { backfill: scanned({ status: "done" }), scoreOffer: null },
    );
    server.use(
      http.post(`${API_ORIGIN}/api/auto-routing/replan`, () =>
        HttpResponse.json({
          ...makeSettings(),
          fit: null,
        } satisfies AutoRoutingSettingsChange),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    expect(
      await screen.findByText("No plan is fitted on these sessions"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Re-plan now" }));

    await waitFor(() =>
      expect(
        screen.queryByText("No plan is fitted on these sessions"),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows how far past sessions got: found and scored", async () => {
    serveBackfill({
      backfill: scanned({
        status: "running",
        phase: "score",
        progress: { scored: 30, sample: 240, noText: 0, failed: 0 },
      }),
      scoreOffer: null,
    });
    renderPage();

    expect(
      await screen.findByTestId("auto-routing-past-sessions-funnel"),
    ).toHaveTextContent("240 found · 30 of 240 scored");
  });

  it("keeps a running scoring run's spend on the summary line", async () => {
    serveBackfill({
      backfill: scanned({
        status: "running",
        phase: "score",
        spentCostUsd: 0.5,
        maxCostUsd: 2,
        progress: { sample: 240, scored: 30, noText: 0, failed: 0 },
      }),
      scoreOffer: null,
    });
    renderPage();

    expect(
      await screen.findByTestId("auto-routing-past-sessions-funnel"),
    ).toHaveTextContent(
      "240 found · 30 of 240 scored · scoring, $0.50 of $2.00",
    );
  });

  it("counts unreadable and failed sessions as done, not pending", async () => {
    serveBackfill({
      backfill: scanned({
        phase: "score",
        progress: { sample: 240, scored: 200, noText: 30, failed: 10 },
      }),
      scoreOffer: null,
    });
    renderPage();

    expect(
      await screen.findByTestId("auto-routing-past-sessions-funnel"),
    ).toHaveTextContent("240 found · 200 scored");
    expect(
      screen.getByText("Not scored: 30 without text, 10 failed"),
    ).toBeInTheDocument();
  });

  it("totals sessions per client, folding agents and the tail", async () => {
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
    });
    renderPage();

    const section = await screen.findByTestId("auto-routing-past-sessions");
    expect(
      within(section)
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
    serveBackfill({ backfill: scanned(), scoreOffer: offer });
    const user = userEvent.setup();
    renderPage();
    const ceiling = await screen.findByLabelText("Spending limit (USD)");
    const action = () =>
      screen.getByRole("button", { name: /^Score 240 sessions/ });

    await user.clear(ceiling);
    await user.type(ceiling, String(AUTO_ROUTING_BACKFILL_MAX_COST_USD));
    expect(action()).toBeEnabled();
    expect(ceiling).toHaveAttribute("aria-invalid", "false");
    await user.type(ceiling, ".01");
    expect(action()).toBeDisabled();
    expect(ceiling).toHaveAttribute("aria-invalid", "true");
  });

  it("refuses a stale offer, closes the confirmation and shows the current offer", async () => {
    const replaced = "00000000-0000-4000-8000-000000000302";
    let refused = 0;
    serveBackfill(
      { backfill: scanned(), scoreOffer: offer },
      {
        backfill: scanned({ id: replaced }),
        scoreOffer: { ...offer, backfillId: replaced, remaining: 90 },
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
    await user.click(
      await screen.findByRole("button", { name: /^Score 240 sessions/ }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /sessions$/ }));

    expect(
      await screen.findByRole("button", { name: /^Score 90 sessions/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(refused).toBe(1);
  });

  it("keeps polling after a backfill until the fit it requested is published", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const done = scanned({ status: "done", phase: "score" });
      serveBackfill(
        { backfill: { ...done, awaitingFit: true }, scoreOffer: null },
        { backfill: { ...done, awaitingFit: true }, scoreOffer: null },
        { backfill: done, scoreOffer: null },
      );
      renderPage();
      await screen.findByTestId("auto-routing-past-sessions");
      settings = withActivePlan(makeSettings());

      await vi.advanceTimersByTimeAsync(5_000);
      // The fit has not published yet: nothing re-read the settings.
      expect(screen.queryByText(/Active plan/)).not.toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await screen.findByText(/Active plan/)).toBeInTheDocument();
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
        cutoff: "2026-10-27T00:00:00.000Z",
      }),
      scoreOffer: {
        ...offer,
        backfillId: older,
        windowStart: "2026-08-01T00:00:00.000Z",
        cutoff: "2026-09-01T00:00:00.000Z",
      },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: /^Score 240 sessions/ }),
    );
    const dialog = await screen.findByRole("dialog");

    expect(dialog).toHaveTextContent(
      `${formatDate({ date: "2026-08-01T00:00:00.000Z" })} to ${formatDate({ date: "2026-09-01T00:00:00.000Z" })}`,
    );
    expect(dialog).not.toHaveTextContent(
      formatDate({ date: "2026-10-20T00:00:00.000Z" }),
    );
    await user.click(within(dialog).getByRole("button", { name: /sessions$/ }));
    await waitFor(() => expect(scores).toMatchObject([{ backfillId: older }]));
  });

  it("scores only after the confirmation, with the ceiling the admin set", async () => {
    const scores = serveBackfill({ backfill: scanned(), scoreOffer: offer });
    const user = userEvent.setup();
    renderPage();
    const ceiling = await screen.findByLabelText("Spending limit (USD)");
    await user.clear(ceiling);
    await user.type(ceiling, "2.5");
    await user.click(
      screen.getByRole("button", { name: /^Score 240 sessions/ }),
    );
    expect(scores).toEqual([]);

    const dialog = await screen.findByRole("dialog");
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

  it("offers a re-score beside an active plan once the scorer changed", async () => {
    settings = makeSettings({
      status: {
        ...makeSettings().status,
        activePlan: { id: PLAN_ID, createdAt: activePlan.createdAt },
      },
    });
    const scores = serveBackfill({
      backfill: scanned({
        status: "superseded",
        phase: "score",
        scorerCurrent: false,
      }),
      scoreOffer: { ...offer, rescore: true },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Re-score" }));
    await user.click(
      await screen.findByRole("button", { name: /^Re-score 240 sessions/ }),
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: /sessions$/,
      }),
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
      status: { ...makeSettings().status, scorer: "no_jev_key" },
    });
    serveBackfill({ backfill: scanned(), scoreOffer: offer });
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
    expect(screen.getAllByTestId("auto-routing-add-jev-key")).toHaveLength(3);
    expect(
      screen.queryByPlaceholderText("A first message of a session"),
    ).not.toBeInTheDocument();
  });

  it("beside an active plan with nothing to score, offers only a scan", async () => {
    settings = makeSettings({
      status: {
        ...makeSettings().status,
        activePlan: { id: PLAN_ID, createdAt: activePlan.createdAt },
      },
    });
    serveBackfill({
      backfill: scanned({
        status: "done",
        progress: { sample: 240, scored: 238, noText: 2, failed: 0 },
      }),
      scoreOffer: null,
    });
    let scans = 0;
    server.use(
      http.post(`${API_ORIGIN}/api/auto-routing/backfill/scan`, () => {
        scans++;
        return HttpResponse.json({
          backfill: scanned({ status: "running" }),
          scoreOffer: null,
        } satisfies AutoRoutingBackfillState);
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Scan past sessions" }),
    );

    await waitFor(() => expect(scans).toBe(1));
  });

  it("shows spend only for a scoring run, not for a scan", async () => {
    serveBackfill({
      backfill: scanned({
        progress: { sample: 240, scored: 200, noText: 0, failed: 0 },
      }),
      scoreOffer: offer,
    });
    renderPage();

    const section = await screen.findByTestId("auto-routing-past-sessions");
    expect(
      within(section).getByTestId("auto-routing-past-sessions-funnel"),
    ).toHaveTextContent("200 of 240 scored");
    expect(within(section).queryByText(/Spent/)).not.toBeInTheDocument();
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
