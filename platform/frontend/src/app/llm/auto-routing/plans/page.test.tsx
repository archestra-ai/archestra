import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  AutoRoutingPlanDetail,
  AutoRoutingPlanSummary,
} from "@/lib/auto-routing.query";
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

const detail: AutoRoutingPlanDetail = {
  ...base,
  tiersFingerprint: {},
  plan: {
    size_model: {
      kind: "poisson_glm",
      baseline: "unknown",
      intercept: Math.log(0.05),
      source_effects: [{ source: "claude-code", coef: Math.log(3) }],
      p_long: Math.log(2),
    },
    long_share: { intercept: -0.5, log_size: 0.1, is_subagent: 0.05 },
  },
};

const server = setupServer(
  http.get(`${API_ORIGIN}/api/auto-routing/plans`, () =>
    HttpResponse.json([base, failed]),
  ),
  http.get(`${API_ORIGIN}/api/auto-routing/plans/${base.id}`, () =>
    HttpResponse.json(detail),
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
    expect(screen.getAllByText("jev · jev-1.13.0 · abcdef01")).toHaveLength(2);
    expect(screen.getByText("420")).toBeInTheDocument();
  });

  it("opens a plan's fitted models and holdout check from its row", async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AutoRoutingPlansPage />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByText("420"));

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText("50,000 tokens"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("× 3.00 tokens")).toBeInTheDocument();
    expect(within(dialog).getByText("× 2.00 tokens")).toBeInTheDocument();
    expect(within(dialog).getByText("0.812")).toBeInTheDocument();
    expect(within(dialog).getByText("1,350,000")).toBeInTheDocument();
  });
});
