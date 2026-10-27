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
} from "vitest";
import type { AutoRoutingDiagnostics } from "@/lib/auto-routing.query";
import AutoRoutingDiagnosticsPage from "./page";

const API_ORIGIN = "http://localhost:9000";

function ready(budgetUsdPerDay: number): AutoRoutingDiagnostics {
  const smart = budgetUsdPerDay > 50 ? 0.25 : 0.05;
  return {
    status: "ready",
    budgetUsdPerDay,
    savedBudgetUsdPerDay: 50,
    lamStar: 200_000,
    q: 0.4,
    usdPerToken: [1e-7, 6e-7, 2e-6],
    tierSessionShare: [0.55, 0.95 - 0.55 - smart + 0.05, smart],
    sizeFit: {
      testSessions: 2,
      spearman: 0.53,
      medianRealizedOverPredicted: 0.79,
    },
    sessions: [
      {
        tierNeeded: [0.7, 0.2, 0.1],
        pLong: 0.2,
        realizedTokens: 120_000,
        predictedTokens: null,
        usdPerToken: [1e-7, 6e-7, 2e-6],
        tier: "fast",
      },
      {
        tierNeeded: [0.1, 0.6, 0.3],
        pLong: 0.5,
        realizedTokens: 3_000_000,
        predictedTokens: 2_000_000,
        usdPerToken: [1e-7, 6e-7, 2e-6],
        tier: "normal",
      },
      {
        tierNeeded: [0, 0.3, 0.7],
        pLong: 0.6,
        realizedTokens: 9_000_000,
        predictedTokens: 12_000_000,
        usdPerToken: [1e-7, 6e-7, 2e-6],
        tier: "smart",
      },
    ],
  };
}

let response: (budget: string | null) => AutoRoutingDiagnostics;
const requestedBudgets: (string | null)[] = [];

const server = setupServer(
  http.get(`${API_ORIGIN}/api/auto-routing/diagnostics`, ({ request }) => {
    const budget = new URL(request.url).searchParams.get("budgetUsdPerDay");
    requestedBudgets.push(budget);
    return HttpResponse.json(response(budget));
  }),
);

beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  requestedBudgets.length = 0;
  response = (budget) => ready(budget === null ? 50 : Number(budget));
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AutoRoutingDiagnosticsPage />
    </QueryClientProvider>,
  );
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
    const routing = screen.getByRole("region", { name: "Routing regions" });
    expect(within(routing).getByText("5%")).toBeInTheDocument();
    expect(requestedBudgets).toEqual([null]);
  });

  it("re-solves at the budget the slider moves to", async () => {
    const user = userEvent.setup();
    renderPage();
    const slider = await screen.findByRole("slider");

    slider.focus();
    await user.keyboard("{ArrowRight}");

    await waitFor(() => expect(requestedBudgets).toContain("51"));
    const routing = screen.getByRole("region", { name: "Routing regions" });
    expect(await within(routing).findByText("25%")).toBeInTheDocument();
  });

  it("shows no blocks without an active plan", async () => {
    response = () => ({ status: "cold_start" });
    renderPage();

    await waitFor(() => expect(requestedBudgets).toEqual([null]));
    await waitFor(() =>
      expect(screen.queryByRole("region")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    expect(document.querySelector("[data-slot=skeleton]")).toBeNull();
  });
});
