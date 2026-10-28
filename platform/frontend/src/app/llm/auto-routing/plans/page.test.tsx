import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AutoRoutingPlanSummary } from "@/lib/auto-routing.query";
import { rejectionReason } from "../_parts/plan-document";
import AutoRoutingPlansPage from "./page";

const API_ORIGIN = "http://localhost:9000";

const base: AutoRoutingPlanSummary = {
  id: "00000000-0000-4000-8000-000000000001",
  createdAt: "2026-10-20T08:00:00.000Z",
  trigger: "nightly",
  status: "active",
  generation: 4,
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
  diagnostics: {
    holdout: {
      status: "evaluated",
      sessions: 37,
      predicted_tokens: 1_200_000,
      realized_tokens: 1_350_000,
      spearman: 0.8123,
    },
  },
  error: null,
  decisionCount: 420,
};
const failed: AutoRoutingPlanSummary = {
  ...base,
  id: "00000000-0000-4000-8000-000000000002",
  trigger: "manual",
  status: "failed",
  generation: 3,
  summary: null,
  diagnostics: null,
  error:
    "ARCHESTRA_ROUTER_INFEASIBLE: cheapest routing costs 8.85889296187498 USD/day, above the 0.01 USD/day budget",
  decisionCount: 0,
};

const rejected: AutoRoutingPlanSummary = {
  ...base,
  id: "00000000-0000-4000-8000-000000000003",
  status: "rejected",
  generation: 2,
  summary: null,
  error: "stale_watermark",
  decisionCount: 0,
};

const server = setupServer(
  http.get(`${API_ORIGIN}/api/auto-routing/plans`, () =>
    HttpResponse.json([base, failed, rejected]),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("AutoRoutingPlansPage", () => {
  it("lists plan history with its spend, tier split and errors", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AutoRoutingPlansPage />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(
        "Budget too low for these models: the cheapest routing costs $8.86/day.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("$12.50/day")).toBeInTheDocument();
    expect(screen.getByText("50% / 30% / 20%")).toBeInTheDocument();
    expect(screen.getByText("420")).toBeInTheDocument();
  });

  it("offers a retry when plan history fails to load", async () => {
    let fail = true;
    server.use(
      http.get(`${API_ORIGIN}/api/auto-routing/plans`, () =>
        fail
          ? HttpResponse.json(
              { error: { message: "Unavailable" } },
              { status: 500 },
            )
          : HttpResponse.json([base]),
      ),
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <AutoRoutingPlansPage />
      </QueryClientProvider>,
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByText("No plans yet")).not.toBeInTheDocument();

    fail = false;
    await user.click(retry);

    expect(await screen.findByText("420")).toBeInTheDocument();
  });

  it("shows a fit rejected at publication with its reason, not as an error", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AutoRoutingPlansPage />
      </QueryClientProvider>,
    );

    const row = (await screen.findByText("rejected")).closest("tr");
    if (!row) throw new Error("rejected plan row missing");
    expect(
      within(row).getByText(rejectionReason("stale_watermark")),
    ).not.toHaveClass("text-destructive");
  });
});
