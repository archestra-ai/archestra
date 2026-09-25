import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
import { OverviewTab } from "./overview-tab";

vi.mock("./coverage-charts", () => ({
  CoverageCharts: () => <div>Coverage charts</div>,
}));
vi.mock("./entities-table", () => ({
  EntitiesTable: () => <div>Entities table</div>,
}));
vi.mock("./overview-setup-cards", async (importActual) => ({
  ...(await importActual<typeof import("./overview-setup-cards")>()),
  OverviewSetupCards: () => null,
}));

const api = "http://localhost:9000/api";
const server = setupServer();
let enabled: boolean;
let revision: number;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  enabled = false;
  revision = 0;
  server.use(
    http.get(`${api}/guardrails-deployment`, () =>
      HttpResponse.json({ enabled, featureEnabled: true, active: enabled }),
    ),
    http.get(`${api}/guardrails-policy`, () =>
      HttpResponse.json({
        organizationId: "org",
        revision,
        content: "",
        contentHash: "hash",
        updatedBy: null,
        updatedAt: null,
      }),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <OverviewTab />
    </QueryClientProvider>,
  );
}

test("a fresh instance hides coverage", async () => {
  show();
  await waitFor(() =>
    expect(screen.queryByText("Coverage charts")).not.toBeInTheDocument(),
  );
  expect(screen.queryByText("Entities table")).not.toBeInTheDocument();
});

test.each([
  ["enforcement is on", true, 0],
  ["a policy is saved", false, 2],
])("shows coverage when %s", async (_, on, saved) => {
  enabled = on;
  revision = saved;
  show();
  expect(await screen.findByText("Coverage charts")).toBeInTheDocument();
  expect(screen.getByText("Entities table")).toBeInTheDocument();
});
