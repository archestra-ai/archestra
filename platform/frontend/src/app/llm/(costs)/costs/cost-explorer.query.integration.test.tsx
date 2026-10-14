import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  useAppUsage,
  useKpis,
  useSkillUsage,
  useToolCallUsage,
  useUserUsageWithSeries,
} from "./cost-explorer.query";
import { usePivotCube } from "./cost-explorer-data";

vi.mock("sonner");
const origin = "http://localhost:9000";
const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: origin });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const response = (data: unknown[], hasNext = false, limit = 100) => ({
  data,
  totals: { calls: 2, errors: 1 },
  pagination: {
    currentPage: 1,
    limit,
    total: 2,
    totalPages: hasNext ? 2 : 1,
    hasNext,
    hasPrev: false,
  },
});

it("serializes grouped dimensions as a comma list and collects later pages", async () => {
  const offsets: number[] = [];
  server.use(
    http.get(`${origin}/api/statistics/mcp-tool-calls`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      expect(query.get("groupBy")).toBe("day,toolName");
      expect(query.get("limit")).toBe("100");
      const offset = Number(query.get("offset"));
      offsets.push(offset);
      return HttpResponse.json(
        response(
          [
            {
              day: "2026-01-01",
              toolName: offset ? "second" : "first",
              calls: 1,
              errors: offset ? 1 : 0,
            },
          ],
          offset === 0,
        ),
      );
    }),
  );
  const { result } = renderHook(
    () => useToolCallUsage({ timeframe: "30d", groupBy: ["day", "toolName"] }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.data.map((row) => row.toolName)).toEqual([
    "first",
    "second",
  ]);
  expect(offsets).toEqual([0, 100]);
});

it("handles encrypted tool names and preserves error counts in the explorer", async () => {
  server.use(
    http.get(`${origin}/api/statistics/mcp-tool-calls`, () =>
      HttpResponse.json(
        response([
          {
            day: "2026-01-01",
            mcpServerName: "sample",
            toolName: null,
            calls: 4,
            errors: 2,
          },
        ]),
      ),
    ),
  );
  const { result } = renderHook(
    () =>
      usePivotCube(
        { metric: "toolCalls", group: "tool", split: "none", chart: "bars" },
        "30d",
        true,
      ),
    { wrapper },
  );
  await waitFor(() => expect(result.current.total).toBe(4));
  expect(result.current.rows[0].extras).toMatchObject({
    errors: 2,
    errorRate: 0.5,
  });
  expect(result.current.error).toBeUndefined();
});

it("distinguishes app opens from inference and includes all groups", async () => {
  server.use(
    http.get(`${origin}/api/statistics/app-usage`, ({ request }) => {
      expect(new URL(request.url).searchParams.get("groupBy")).toBe(
        "day,appId,userId",
      );
      return HttpResponse.json({
        ...response([
          {
            day: "2026-01-01",
            appId: "sample",
            userId: "person",
            runs: 9,
            toolCalls: 3,
            llmRequests: 2,
            inputTokens: 20,
            outputTokens: 10,
            billedCost: 1,
            subscriptionCost: 0,
          },
        ]),
        totals: {
          runs: 9,
          toolCalls: 3,
          llmRequests: 2,
          inputTokens: 20,
          outputTokens: 10,
          billedCost: 1,
          subscriptionCost: 0,
        },
      });
    }),
  );
  const { result } = renderHook(
    () =>
      useAppUsage({ timeframe: "30d", groupBy: ["day", "appId", "userId"] }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.data[0]).toMatchObject({
    runs: 9,
    llmRequests: 2,
    toolCalls: 3,
  });
});

it("keeps skill reach distinct from activation counts", async () => {
  server.use(
    http.get(`${origin}/api/statistics/skill-usage`, () =>
      HttpResponse.json({
        ...response([
          { skillId: "sample", activations: 7, contextTokens: 300, users: 2 },
        ]),
        totals: { activations: 7, contextTokens: 300, users: 2 },
      }),
    ),
  );
  const { result } = renderHook(
    () => useSkillUsage({ timeframe: "30d", groupBy: ["skillId"] }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.data[0]).toMatchObject({
    activations: 7,
    users: 2,
  });
});

it("fetches every user and requests their per-model series", async () => {
  const offsets: number[] = [];
  server.use(
    http.get(`${origin}/api/statistics/users`, ({ request }) => {
      const q = new URL(request.url).searchParams;
      const offset = Number(q.get("offset"));
      offsets.push(offset);
      expect(q.get("includeModels")).toBe("true");
      expect(q.get("includeModelTimeSeries")).toBe("true");
      return HttpResponse.json(
        response(
          [{ userId: offset ? "second" : "first", requests: 1 }],
          offset === 0,
        ),
      );
    }),
  );
  const { result } = renderHook(
    () => useUserUsageWithSeries({ timeframe: "30d", includeModels: true }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.data).toHaveLength(2);
  expect(offsets).toEqual([0, 100]);
});

it.each([
  403, 500,
])("renders a query error rather than reporting no activity for HTTP %s", async (status) => {
  server.use(
    http.get(`${origin}/api/statistics/mcp-tool-calls`, () =>
      HttpResponse.json(
        { error: { message: "Unavailable", type: "api_authorization_error" } },
        { status },
      ),
    ),
  );
  const { result } = renderHook(
    () =>
      usePivotCube(
        { metric: "toolCalls", group: "server", split: "none", chart: "bars" },
        "30d",
        true,
      ),
    { wrapper },
  );
  await waitFor(() => expect(result.current.error).toBeTruthy());
  expect(result.current.isLoading).toBe(false);
});

it("aligns uneven model series by timestamp without crashing the overview", async () => {
  server.use(
    http.get(`${origin}/api/statistics/models`, () =>
      HttpResponse.json([
        {
          model: "first",
          requests: 9,
          inputTokens: 90,
          outputTokens: 9,
          cacheReadTokens: 0,
          timeSeries: [
            { timestamp: "2026-01-01T00:00:00Z", requests: 4, inputTokens: 40 },
            { timestamp: "2026-01-02T00:00:00Z", requests: 5, inputTokens: 50 },
          ],
        },
        {
          model: "second",
          requests: 3,
          inputTokens: 30,
          outputTokens: 3,
          cacheReadTokens: 0,
          timeSeries: [
            { timestamp: "2026-01-02T00:00:00Z", requests: 3, inputTokens: 30 },
          ],
        },
      ]),
    ),
    http.get(`${origin}/api/statistics/cost-savings`, () =>
      HttpResponse.json({
        totalActualCost: 1,
        totalSubscriptionCost: 2,
        timeSeries: [],
      }),
    ),
    http.get(`${origin}/api/statistics/users`, () =>
      HttpResponse.json(response([])),
    ),
  );
  const { result } = renderHook(
    () => useKpis({ timeframe: "30d", enabled: true }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.isUsagePending).toBe(false));
  expect(result.current.requests).toEqual({ value: 12, series: [4, 8] });
  expect(result.current.tokens).toEqual({ value: 132, series: [40, 80] });
});
