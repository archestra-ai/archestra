import { archestraApiClient } from "@archestra/shared";
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
import type { AutoRoutingDiagnostics } from "@/lib/auto-routing.query";
import { budgetScale } from "../_parts/budget-scale";
import AutoRoutingDiagnosticsPage from "./page";

const API_ORIGIN = "http://localhost:9000";
const SAVED = 50;
const scale = budgetScale(SAVED);
/** The budgets one and two slider steps above the saved one. */
const [STEP_1, STEP_2] = [1, 2].map((k) =>
  scale.budgetAt(Math.round(scale.savedPosition) + k),
);
const PRICES: [number, number, number] = [1e-7, 6e-7, 2e-6];

/** Its smart share, budget / 200, identifies the budget a result was solved at. */
function ready(
  budgetUsdPerDay: number,
  savedBudgetUsdPerDay = SAVED,
): AutoRoutingDiagnostics {
  const smart = budgetUsdPerDay / 200;
  return {
    status: "ready",
    budgetUsdPerDay,
    savedBudgetUsdPerDay,
    lamStar: 200_000,
    q: 0.4,
    tierSessionShare: [0.6, 0.4 - smart, smart],
    sizeFit: {
      status: "ok",
      testSessions: 2,
      plotted: 2,
      excluded: 0,
      spearman: 0.53,
      medianRealizedOverPredicted: 0.79,
    },
    sessions: [
      {
        tierNeeded: [0.7, 0.2, 0.1],
        pLong: 0.2,
        realizedTokens: 120_000,
        predictedTokens: null,
        usdPerToken: PRICES,
        tier: "fast",
      },
      {
        tierNeeded: [0.1, 0.6, 0.3],
        pLong: 0.5,
        realizedTokens: 3_000_000,
        predictedTokens: 2_000_000,
        usdPerToken: PRICES,
        tier: "normal",
      },
    ],
  };
}

const failure = (status: 429 | 500) =>
  HttpResponse.json(
    {
      error: {
        message: "refused",
        type:
          status === 429 ? "api_rate_limit_error" : "api_internal_server_error",
      },
    },
    { status },
  );

let respond: (budget: number | null) => Promise<Response> | Response;
const requestedBudgets: (number | null)[] = [];
const gates = new Map<number, () => void>();
/** Answers a changed budget only once its gate is opened. */
const gated = async (budget: number | null) => {
  if (budget !== null) {
    await new Promise<void>((open) => gates.set(budget, open));
  }
  return HttpResponse.json(ready(budget ?? SAVED));
};

const PLAN_ID = "00000000-0000-4000-8000-000000000001";

const server = setupServer(
  http.get(`${API_ORIGIN}/api/auto-routing/settings`, () =>
    HttpResponse.json({
      status: {
        activePlan: { id: PLAN_ID, createdAt: "2026-10-27T22:10:33Z" },
      },
    }),
  ),
  http.get(`${API_ORIGIN}/api/auto-routing/plans/${PLAN_ID}`, () =>
    HttpResponse.json({
      id: PLAN_ID,
      diagnostics: {
        history: {
          sessions: 3000,
          past_sessions: 2400,
          last_created_at: "2026-10-25T21:09:27Z",
        },
      },
    }),
  ),
  http.get(`${API_ORIGIN}/api/auto-routing/diagnostics`, ({ request }) => {
    const param = new URL(request.url).searchParams.get("budgetUsdPerDay");
    const budget = param === null ? null : Number(param);
    requestedBudgets.push(budget);
    return respond(budget);
  }),
);

beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  requestedBudgets.length = 0;
  gates.clear();
  respond = (budget) => HttpResponse.json(ready(budget ?? SAVED));
});
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
});
afterAll(() => server.close());

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AutoRoutingDiagnosticsPage />
    </QueryClientProvider>,
  );
  return queryClient;
}

const routing = () => screen.getByRole("region", { name: "Routing regions" });
const shownBudget = () => screen.getByRole("status", { name: "Shown budget" });
const share = (budget: number) => `${Math.round((budget / 200) * 100)}%`;

async function step(user: ReturnType<typeof userEvent.setup>, budget: number) {
  (await screen.findByRole("slider")).focus();
  await user.keyboard("{ArrowRight}");
  await waitFor(() => expect(requestedBudgets).toContain(budget));
}

function expectShown(budget: number) {
  expect(shownBudget()).toHaveTextContent(`$${budget.toFixed(2)}/day`);
  expect(within(routing()).getByText(share(budget))).toBeInTheDocument();
}

describe("AutoRoutingDiagnosticsPage", () => {
  it("renders the Jev, size and routing blocks with their metrics", async () => {
    renderPage();

    const regions = await screen.findAllByRole("region");
    expect(regions).toHaveLength(3);
    const size = screen.getByRole("region", {
      name: "Predicted vs realized tokens",
    });
    expect(within(size).getByText("0.53")).toBeInTheDocument();
    expect(within(size).getByText("0.79×")).toBeInTheDocument();
    expectShown(SAVED);
    expect(requestedBudgets).toEqual([null]);
  });

  it("summarizes what the active plan was trained on", async () => {
    renderPage();

    const summary = await screen.findByTestId("auto-routing-training-summary");
    await waitFor(() =>
      expect(summary).toHaveTextContent(
        "Trained on3,000 sessionsPast traffic80%Data up toOct 25, 2026",
      ),
    );
  });

  it("shows no size metrics without a holdout", async () => {
    respond = () =>
      HttpResponse.json({ ...ready(SAVED), sizeFit: { status: "no_holdout" } });
    renderPage();

    const size = await screen.findByRole("region", {
      name: "Predicted vs realized tokens",
    });
    expect(
      within(size)
        .getAllByRole("definition")
        .map((d) => d.textContent),
    ).toEqual(["–", "–", "–", "–"]);
  });

  it("keeps the shown budget's result until the next one arrives", async () => {
    respond = gated;
    const user = userEvent.setup();
    renderPage();

    await step(user, STEP_1);
    expectShown(SAVED);

    gates.get(STEP_1)?.();
    await waitFor(() => expectShown(STEP_1));
  });

  it("shows only the latest budget's result after rapid changes", async () => {
    respond = gated;
    const user = userEvent.setup();
    renderPage();

    await step(user, STEP_1);
    await step(user, STEP_2);
    gates.get(STEP_1)?.();
    await new Promise((settle) => setTimeout(settle, 100));
    expectShown(SAVED);

    gates.get(STEP_2)?.();
    await waitFor(() => expectShown(STEP_2));
  });

  it("keeps the shown result and offers a retry when a budget fails", async () => {
    respond = (budget) =>
      budget === null ? HttpResponse.json(ready(SAVED)) : failure(500);
    const user = userEvent.setup();
    renderPage();

    await step(user, STEP_1);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expectShown(SAVED);

    respond = (budget) => HttpResponse.json(ready(budget ?? SAVED));
    await user.click(retry);
    await waitFor(() => expectShown(STEP_1));
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });

  it("offers a retry once refused runs exhaust their retries", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    respond = (budget) =>
      budget === null ? HttpResponse.json(ready(SAVED)) : failure(429);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();

    await step(user, STEP_1);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(
      await screen.findByRole("button", { name: "Retry" }),
    ).toBeInTheDocument();
    expect(requestedBudgets.filter((b) => b === STEP_1)).toHaveLength(11);
    expectShown(SAVED);
  });

  it("names the slider thumb and gives its value in dollars", async () => {
    renderPage();

    const slider = await screen.findByRole("slider", { name: "Budget" });

    expect(slider).toHaveAttribute(
      "aria-valuetext",
      `$${SAVED.toFixed(2)}/day`,
    );
  });

  it("keeps following the saved budget when it refreshes", async () => {
    let saved = 0.01;
    respond = (budget) => HttpResponse.json(ready(budget ?? saved, saved));
    const queryClient = renderPage();
    await screen.findByRole("slider", { name: "Budget" });

    saved = SAVED;
    await queryClient.refetchQueries();
    await waitFor(() => expectShown(SAVED));
    await new Promise((settle) => setTimeout(settle, 400));

    expect(requestedBudgets).toEqual([null, null]);
    const slider = screen.getByRole("slider", { name: "Budget" });
    expect(slider).toHaveAttribute(
      "aria-valuenow",
      String(scale.savedPosition),
    );
    expect(slider).toHaveAttribute(
      "aria-valuetext",
      `$${SAVED.toFixed(2)}/day`,
    );
  });

  it("steps by keyboard through cent-rounding plateaus at low budgets", async () => {
    respond = (budget) => HttpResponse.json(ready(budget ?? 0.01, 0.01));
    const user = userEvent.setup();
    renderPage();
    (await screen.findByRole("slider", { name: "Budget" })).focus();

    await user.keyboard("{ArrowRight>40/}");

    expect(screen.getByRole("slider", { name: "Budget" })).toHaveAttribute(
      "aria-valuetext",
      "$0.02/day",
    );
    await waitFor(() => expect(requestedBudgets).toContain(0.02));
  });

  it("shows no blocks without an active plan", async () => {
    respond = () => HttpResponse.json({ status: "cold_start" });
    renderPage();

    await waitFor(() => expect(requestedBudgets).toEqual([null]));
    await waitFor(() =>
      expect(screen.queryByRole("region")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    expect(document.querySelector("[data-slot=skeleton]")).toBeNull();
  });
});
