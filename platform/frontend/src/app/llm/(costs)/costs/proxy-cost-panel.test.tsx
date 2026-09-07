import { archestraApiClient, type archestraApiTypes } from "@archestra/shared";
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
} from "vitest";
import { ProxyCostPanel } from "./proxy-cost-panel";

const endpoint = "http://localhost:9000/api/statistics/llm-proxy";
const server = setupServer();
const totals = {
  requests: 12,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 100,
  billedCost: 3.5,
  subscriptionCost: 7,
};
const data: archestraApiTypes.GetProxyCostStatisticsResponses["200"] = {
  totals,
  methods: [{ ...totals, authMethod: "virtual_key" }],
  timeSeries: [{ ...totals, timestamp: "2026-09-01T12:00:00Z" }],
  credentials: [
    {
      ...totals,
      authMethod: "virtual_key",
      credentialId: "key-1",
      credentialName: "Build pipeline",
    },
  ],
  pagination: { total: 11, limit: 10, offset: 0 },
};
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProxyCostPanel timeframe="24h" enabled />
    </QueryClientProvider>,
  );
}

test("filters the real API query when a credential is selected, clears it, and pages details without shrinking totals", async () => {
  const urls: URL[] = [];
  server.use(
    http.get(endpoint, ({ request }) => {
      const url = new URL(request.url);
      urls.push(url);
      return HttpResponse.json({
        ...data,
        pagination: {
          ...data.pagination,
          offset: Number(url.searchParams.get("offset")),
        },
      });
    }),
  );
  renderPanel();
  fireEvent.click(
    await screen.findByRole("button", { name: "Build pipeline" }),
  );
  await waitFor(() =>
    expect(urls.at(-1)?.searchParams.get("credentialId")).toBe("key-1"),
  );
  expect(urls.at(-1)?.searchParams.get("authMethod")).toBe("virtual_key");
  fireEvent.click(
    await screen.findByRole("button", { name: "Back to all credentials" }),
  );
  await screen.findByRole("button", { name: "Next" });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(urls.at(-1)?.searchParams.get("offset")).toBe("10"),
  );
  expect(urls.at(-1)?.searchParams.has("credentialId")).toBe(false);
  expect(screen.getAllByText("$3.50").length).toBeGreaterThan(0);
  expect(screen.getByText("Subscription-covered estimate")).toBeInTheDocument();
});

test("shows an OAuth application's own totals when its credential is selected", async () => {
  const appTotals = {
    ...totals,
    requests: 3,
    billedCost: 1.25,
    subscriptionCost: 0,
  };
  const app = {
    ...appTotals,
    authMethod: "oauth_client_credentials",
    credentialId: "workflow-service",
    credentialName: "Workflow service",
  };
  server.use(
    http.get(endpoint, ({ request }) => {
      const query = new URL(request.url).searchParams;
      const filtered =
        query.get("credentialId") === app.credentialId &&
        query.get("authMethod") === app.authMethod;
      return HttpResponse.json({
        ...data,
        totals: filtered ? appTotals : totals,
        credentials: filtered ? [app] : [...data.credentials, app],
        pagination: { total: filtered ? 1 : 2, limit: 10, offset: 0 },
      });
    }),
  );
  renderPanel();
  fireEvent.click(
    await screen.findByRole("button", { name: "Workflow service" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Build pipeline" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.queryByText("$3.50")).not.toBeInTheDocument();
  expect(await screen.findAllByText("$1.25")).toHaveLength(2);
  fireEvent.click(
    screen.getByRole("button", { name: "Back to all credentials" }),
  );
  expect(
    await screen.findByRole("button", { name: "Build pipeline" }),
  ).toBeInTheDocument();
  expect(screen.getAllByText("$3.50")).toHaveLength(2);
  expect(
    screen.queryByRole("button", { name: "Back to all credentials" }),
  ).not.toBeInTheDocument();
});

test("renders a retryable error rather than an empty usage report and recovers", async () => {
  let fail = true;
  server.use(
    http.get(endpoint, () =>
      fail
        ? HttpResponse.json(
            {
              error: {
                message: "Unavailable",
                type: "api_internal_server_error",
              },
            },
            { status: 500 },
          )
        : HttpResponse.json(data),
    ),
  );
  renderPanel();
  expect(
    await screen.findByText("Could not load proxy costs"),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("No proxy requests for this timeframe and filter."),
  ).not.toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("button", { name: "Build pipeline" }),
  ).toBeInTheDocument();
});

test("shows no requests after a successful empty response", async () => {
  server.use(
    http.get(endpoint, () =>
      HttpResponse.json({
        ...data,
        totals: { ...totals, requests: 0 },
        credentials: [],
        timeSeries: [],
        methods: [],
      }),
    ),
  );
  renderPanel();
  expect(
    await screen.findByText("No proxy requests for this timeframe and filter."),
  ).toBeInTheDocument();
});
