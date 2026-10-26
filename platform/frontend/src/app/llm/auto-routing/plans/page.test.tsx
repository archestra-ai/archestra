import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
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
  summary: null,
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
  diagnostics: null,
  error: "ARCHESTRA_ROUTER_INFEASIBLE: budget below the cheapest tier",
  decisionCount: 0,
};

const rejected: AutoRoutingPlanSummary = {
  ...base,
  id: "00000000-0000-4000-8000-000000000003",
  status: "rejected",
  generation: 2,
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
  it("lists plan history with its scorer and errors", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AutoRoutingPlansPage />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(/budget below the cheapest tier/),
    ).toBeInTheDocument();
    expect(screen.getAllByText("jev · jev-1.13.0 · abcdef01")).toHaveLength(3);
    expect(screen.getByText("420")).toBeInTheDocument();
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
