import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useMyTeams, useTeams } from "@/lib/teams/team.query";
import { BudgetFields } from "./budget-fields";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/teams/team.query");

const origin = "http://localhost:9000";
const server = setupServer();
const TEAM = { id: "team-support", name: "Support", memberCount: 3 };

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: origin });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
beforeEach(() => {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "u-self" } },
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useTeams).mockReturnValue({
    data: [TEAM],
  } as unknown as ReturnType<typeof useTeams>);
  vi.mocked(useMyTeams).mockReturnValue({
    data: [TEAM],
  } as unknown as ReturnType<typeof useMyTeams>);
});

it("asks the server for the billing team's cost limits only", async () => {
  const queries: string[] = [];
  server.use(
    http.get(`${origin}/api/limits`, ({ request }) => {
      queries.push(new URL(request.url).search);
      return HttpResponse.json([
        {
          id: "00000000-0000-4000-8000-000000000001",
          entityType: "team",
          entityId: TEAM.id,
          limitType: "token_cost",
          model: null,
          limitValue: 300,
          cleanupInterval: "calendar_month",
          modelUsage: [
            { model: "claude", tokensIn: 1, tokensOut: 1, cost: 40 },
          ],
        },
      ]);
    }),
  );

  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BudgetFields
        subject="key"
        idPrefix="test"
        billingTeamId={TEAM.id}
        onBillingTeamIdChange={vi.fn()}
        spendCap={null}
        onSpendCapChange={vi.fn()}
      />
    </QueryClientProvider>,
  );

  expect(
    await screen.findByRole("img", {
      name: /^Support has used \$40 of \$300/,
    }),
  ).toBeInTheDocument();
  expect(queries).toEqual([
    `?entityType=team&entityId=${TEAM.id}&limitType=token_cost`,
  ]);
});
