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
  vi,
} from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { LabelAttributionPanel } from "./label-attribution-panel";

vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");
const server = setupServer();
const endpoint = "http://localhost:9000/api/statistics/llm-proxy";
const counts = {
  requests: 1,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  billedCost: 1.25,
  subscriptionCost: 0,
};
const urls: URL[] = [];

function response(
  groups: { value: string | null }[],
  total = groups.length,
  offset = 0,
): archestraApiTypes.GetProxyCostStatisticsResponses["200"] {
  return {
    totals: {
      ...counts,
      requests: total,
      billedCost: total * counts.billedCost,
    },
    credentials: [],
    methods: [],
    timeSeries: [],
    pagination: { limit: 100, offset, total: 0 },
    labels: {
      key: "cost_center",
      groups: groups.map((row) => ({ ...counts, ...row })),
      pagination: { limit: 100, offset, total },
    },
  };
}
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  urls.length = 0;
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderPanel() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <LabelAttributionPanel timeframe="24h" enabled />
    </QueryClientProvider>,
  );
}

test("collects every page for the table and CSV, then applies exact value and unassigned filters", async () => {
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  server.use(
    http.get(endpoint, ({ request }) => {
      const url = new URL(request.url);
      urls.push(url);
      const offset = Number(url.searchParams.get("offset"));
      if (url.searchParams.get("labelUnassigned") === "true")
        return HttpResponse.json(response([{ value: null }]));
      if (url.searchParams.get("labelValue"))
        return HttpResponse.json(response([{ value: "C101" }]));
      return HttpResponse.json(
        response(
          Array.from({ length: offset ? 3 : 100 }, (_, i) => ({
            value: `C${offset + i}`,
          })),
          103,
          offset,
        ),
      );
    }),
  );
  renderPanel();
  expect(await screen.findByText("C102")).toBeVisible();
  expect(urls.map((url) => url.searchParams.get("offset"))).toEqual([
    "0",
    "100",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Copy all as CSV" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(writeText.mock.calls[0]?.[0]).toContain('"C102"');
  fireEvent.change(screen.getByLabelText("Value (optional)"), {
    target: { value: "C101" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() =>
    expect(urls.at(-1)?.searchParams.get("labelValue")).toBe("C101"),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Unassigned only" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(await screen.findByText("Unassigned (label missing)")).toBeVisible();
  expect(urls.at(-1)?.searchParams.get("labelUnassigned")).toBe("true");
  expect(urls.at(-1)?.searchParams.has("labelValue")).toBe(false);
});

test("a reporting outage stays an error instead of looking like no usage", async () => {
  server.use(
    http.get(endpoint, () =>
      HttpResponse.json({ error: { message: "Unavailable" } }, { status: 503 }),
    ),
  );
  renderPanel();
  expect(
    await screen.findByText("Could not load cost attribution"),
  ).toBeVisible();
  expect(screen.queryByText(/No proxy requests/)).not.toBeInTheDocument();
});

test("a role without cost-read permission makes no attribution request", async () => {
  vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
    typeof useHasPermissions
  >);
  const request = vi.fn(() => HttpResponse.json(response([])));
  server.use(http.get(endpoint, request));
  const { container } = renderPanel();
  expect(container).toBeEmptyDOMElement();
  expect(request).not.toHaveBeenCalled();
});
