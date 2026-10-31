import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render as renderUi,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
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
import { makeUsageData } from "./usage.test-data";
import { UsageContent } from "./usage-content";

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  const { createContext, useContext } = await import("react");
  type Row = Record<string, string | number>;
  const Data = createContext<Row[]>([]);
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => children,
    BarChart: ({ data, children }: { data: Row[]; children: ReactNode }) => (
      <Data.Provider value={data}>
        <output data-testid="chart-data">{JSON.stringify(data)}</output>
        {children}
      </Data.Provider>
    ),
    Bar: () => null,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: ({
      content,
    }: {
      content: (props: {
        active: boolean;
        label: string;
        payload: { dataKey: string; value: number }[];
      }) => ReactNode;
    }) => {
      const [row] = useContext(Data);
      if (!row) return null;
      return (
        <div role="tooltip">
          {content({
            active: true,
            label: String(row.name),
            payload: Object.entries(row)
              .filter(([key]) => key !== "name" && key !== "id")
              .map(([dataKey, value]) => ({ dataKey, value: Number(value) })),
          })}
        </div>
      );
    },
  };
});

const render = (ui: ReactNode) =>
  renderUi(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>,
  );

const server = setupServer();
beforeEach(() => window.history.replaceState(null, "", "/"));
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("usage exploration", () => {
  it.each([
    [9, "$9.00"],
    [-0.25, "-$0.25"],
    [0, "$0.00"],
  ])("explores personal net savings %s without inventing a model breakdown", async (net, formatted) => {
    const user = userEvent.setup();
    const data = makeUsageData();
    data.breakdown.tokenMix.cacheSavings = net;
    render(<UsageContent {...data} />);
    await user.click(screen.getByRole("button", { name: /^Show / }));
    await user.click(
      screen.getByRole("menuitem", { name: "Net cache savings" }),
    );
    expect(screen.getByRole("button", { name: "by All usage" })).toBeVisible();
    expect(screen.getAllByText(formatted).length).toBeGreaterThan(0);
    expect(screen.getByText(/including subscription usage/)).toBeVisible();
    expect(screen.getByRole("button", { name: /^Pivot$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Lines" })).toBeDisabled();
    expect(within(screen.getByRole("table")).getByText("$1.00")).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Prompt caching" }),
    ).not.toBeInTheDocument();
    if (net < 0) {
      await user.click(screen.getByRole("button", { name: "Stacked bars" }));
      expect(
        within(screen.getByRole("tooltip")).getByText(formatted),
      ).toBeVisible();
    }
  });
  it("charts cache reads and writes as selectable personal metrics and exports them", async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, "writeText");
    render(<UsageContent {...makeUsageData()} />);
    await view(user, "Cache reads by model");
    expect(
      screen.getByRole("button", { name: "Show Cache reads" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Copy as CSV" }));
    expect(String(write.mock.calls[0]?.[0])).toContain("1000");
    await user.click(screen.getByRole("button", { name: /^Show / }));
    await user.click(screen.getByRole("menuitem", { name: "Cache writes" }));
    expect(
      screen.getByRole("button", { name: "Show Cache writes" }),
    ).toBeVisible();
    const [data] = JSON.parse(
      screen.getByTestId("chart-data").textContent ?? "[]",
    );
    expect(
      Object.entries(data)
        .filter(([key]) => key !== "name" && key !== "id")
        .reduce((sum, [, value]) => sum + Number(value), 0),
    ).toBe(10);
  });

  it("only shows splitting when the metric and grouping support it", async () => {
    const user = userEvent.setup();
    render(<UsageContent {...makeUsageData()} />);
    expect(
      screen.queryByRole("button", { name: /^split by / }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Show / }));
    await user.click(screen.getByRole("menuitem", { name: "Tokens" }));
    expect(screen.getByRole("button", { name: "split by None" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^Show / }));
    await user.click(screen.getByRole("menuitem", { name: "Billed spend" }));
    expect(
      screen.queryByRole("button", { name: /^split by / }),
    ).not.toBeInTheDocument();
  });

  for (const group of ["Model", "Client"] as const) {
    it(`keeps ${group} token stacks, tooltips and expanded shares consistent`, async () => {
      const user = userEvent.setup();
      render(<UsageContent {...makeUsageData()} />);
      if (group === "Client") await view(user, "Usage by client");
      await user.click(screen.getByRole("button", { name: /^Show / }));
      await user.click(screen.getByRole("menuitem", { name: "Tokens" }));
      await user.click(screen.getByRole("button", { name: "split by None" }));
      await user.click(screen.getByRole("menuitem", { name: "Token type" }));
      const [data] = JSON.parse(
        screen.getByTestId("chart-data").textContent ?? "[]",
      ) as Record<string, string | number>[];
      const chartTotal = Object.entries(data)
        .filter(([key]) => key !== "name" && key !== "id")
        .reduce((sum, [, value]) => sum + Number(value), 0);
      expect(chartTotal).toBe(110);
      const tooltip = screen.getByRole("tooltip");
      expect(within(tooltip).getByText("80")).toBeInTheDocument();
      expect(within(tooltip).getByText("20")).toBeInTheDocument();
      expect(within(tooltip).getByText("10")).toBeInTheDocument();
      expect(
        within(tooltip).queryByText("Cache reads"),
      ).not.toBeInTheDocument();
      const table = screen.getByRole("table");
      expect(within(table).getByText("1,000")).toBeInTheDocument();
      await user.click(
        within(table).getByRole("button", { name: "Expand by Token type" }),
      );
      const shares = within(table)
        .getAllByText(/% of /)
        .map((node) => Number.parseFloat(node.textContent ?? "0"));
      expect(shares).toEqual([73, 18, 9]);
      expect(shares.reduce((sum, share) => sum + share, 0)).toBe(100);
    });
  }
  it("changes from model totals to a real time pivot and falls back when switching to clients", async () => {
    const user = userEvent.setup();
    render(<UsageContent {...makeUsageData()} />);
    expect(screen.getByRole("button", { name: /^pivot$/i })).toBeDisabled();
    await view(user, "Activity over time");
    await user.click(screen.getByRole("button", { name: /^pivot$/i }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByText("3")).toHaveLength(4);
    expect(within(table).queryByText("example-model")).not.toBeInTheDocument();
    await view(user, "Usage by client");
    expect(screen.getByRole("button", { name: /^pivot$/i })).toBeDisabled();
    expect(
      within(screen.getByRole("table")).getByText("Not reported"),
    ).toBeInTheDocument();
  });
  it("keeps token mix and context in the explorer and lets a billed view leave a non-billing grouping", async () => {
    const user = userEvent.setup();
    render(<UsageContent {...makeUsageData()} />);
    await view(user, "Token mix");
    expect(
      within(screen.getByRole("table")).getByText("Cache writes"),
    ).toBeInTheDocument();
    await view(user, "Context size");
    expect(
      within(screen.getByRole("table")).getByText("Under 32K"),
    ).toBeInTheDocument();
    await view(user, "Spend by model");
    expect(
      screen.getByRole("button", { name: "by Model" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("table")).getByText("example-model"),
    ).toBeInTheDocument();
  });
  it("exports the input/output pivot rather than unrelated summary columns", async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, "writeText");
    render(<UsageContent {...makeUsageData()} />);
    await user.click(screen.getByRole("button", { name: /^Show / }));
    await user.click(screen.getByRole("menuitem", { name: "Tokens" }));
    await user.click(screen.getByRole("button", { name: "split by None" }));
    await user.click(screen.getByRole("menuitem", { name: "Token type" }));
    await user.click(screen.getByRole("button", { name: /^pivot$/i }));
    await user.click(screen.getByRole("button", { name: "Copy as CSV" }));
    expect(write).toHaveBeenCalledWith(
      "Model,Input,Output,Cache writes,total\nexample-model,80,20,10,110",
    );
  });
  it("clears a row comparison through the shared toolbar", async () => {
    const user = userEvent.setup();
    render(<UsageContent {...makeUsageData()} />);
    await user.click(
      within(screen.getByRole("table")).getByRole("row", {
        name: /example-model/,
      }),
    );
    expect(screen.getByText("Chart shows example-model")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(
      screen.queryByRole("button", { name: "Clear selection" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Select a model name to explore its clients/),
    ).toBeInTheDocument();
  });
  it("explores a model's clients and timeline through the caller-only API and clears its filter", async () => {
    const requested: URL[] = [];
    server.use(
      http.get(
        "http://localhost:9000/api/statistics/me/model-usage",
        ({ request }) => {
          requested.push(new URL(request.url));
          return HttpResponse.json({
            data: [
              {
                id: "cli",
                name: "Example coding client",
                requests: 4,
                totalTokens: 90,
                cacheReadTokens: 12,
                cacheWriteTokens: 6,
                billedCost: 1.5,
                subscriptionCost: 0,
                timeSeries: [
                  {
                    timestamp: "2026-10-30T00:00:00Z",
                    requests: 4,
                    totalTokens: 90,
                    cacheReadTokens: 12,
                    cacheWriteTokens: 6,
                    billedCost: 1.5,
                    subscriptionCost: 0,
                  },
                ],
              },
            ],
            pagination: { limit: 100, total: 1, hasNext: false },
          });
        },
      ),
    );
    const user = userEvent.setup();
    render(<UsageContent {...makeUsageData()} />);
    await user.click(
      screen.getByRole("button", { name: "Explore example-model" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("table")).toHaveTextContent(
        "Example coding client",
      ),
    );
    await user.click(screen.getByRole("button", { name: /^by / }));
    await user.click(screen.getByRole("menuitem", { name: "Time" }));
    expect(
      screen.getByRole("navigation", { name: "Model drill-down" }),
    ).toHaveTextContent("example-model");
    expect(requested).toHaveLength(1);
    expect(requested[0].searchParams.get("model")).toBe("example-model");
    expect(requested[0].searchParams.get("groupBy")).toBe("client");
    await user.click(
      screen.getByRole("button", { name: "Clear model filter" }),
    );
    expect(
      screen.getByRole("button", { name: "Explore example-model" }),
    ).toBeInTheDocument();
  });
});

async function view(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: /^View / }));
  await user.click(screen.getByRole("menuitem", { name }));
}
