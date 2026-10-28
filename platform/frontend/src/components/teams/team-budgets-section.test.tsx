import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { TeamBudgetsSection } from "./team-budgets-section";

const API_ORIGIN = "http://localhost:9000";
const team = {
  id: "team-a",
  name: "Team A",
} as Parameters<typeof TeamBudgetsSection>[0]["team"];
const server = setupServer();

vi.mock("sonner");

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => archestraApiClient.setConfig({ baseUrl: API_ORIGIN }));
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

test("shows one team's spend and creates a cap for only that team", async () => {
  const requests: Array<{ path: string; teamId: string | null }> = [];
  let createdBody: Record<string, unknown> | null = null;
  server.use(
    http.get(`${API_ORIGIN}/api/limits`, ({ request }) => {
      const url = new URL(request.url);
      requests.push({
        path: url.pathname,
        teamId: url.searchParams.get("entityId"),
      });
      return HttpResponse.json([
        {
          id: "limit-a",
          entityType: "team",
          entityId: team.id,
          limitType: "token_cost",
          limitValue: 100,
          cleanupInterval: "calendar_month",
          model: null,
          modelUsage: [
            { model: "gpt-4o", cost: 25, tokensIn: 1, tokensOut: 1 },
          ],
        },
      ]);
    }),
    http.get(`${API_ORIGIN}/api/statistics/teams`, ({ request }) => {
      const url = new URL(request.url);
      requests.push({
        path: url.pathname,
        teamId: url.searchParams.get("teamId"),
      });
      return HttpResponse.json([{ teamId: team.id, cost: 42, requests: 7 }]);
    }),
    http.post(`${API_ORIGIN}/api/limits`, async ({ request }) => {
      createdBody = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ id: "new-limit", ...createdBody });
    }),
  );

  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamBudgetsSection team={team} open />
    </QueryClientProvider>,
  );

  expect(await screen.findByText("$42.00")).toBeInTheDocument();
  expect(screen.getByText("Spend · $25.00 / $100.00")).toBeInTheDocument();
  expect(requests).toEqual(
    expect.arrayContaining([
      { path: "/api/limits", teamId: team.id },
      { path: "/api/statistics/teams", teamId: team.id },
    ]),
  );

  fireEvent.change(screen.getByLabelText("Amount (USD)"), {
    target: { value: "150" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add limit" }));
  await waitFor(() =>
    expect(createdBody).toMatchObject({
      entityType: "team",
      entityId: team.id,
      limitType: "token_cost",
      limitValue: 150,
      cleanupInterval: "calendar_month",
    }),
  );
});
