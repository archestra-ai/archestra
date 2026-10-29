import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { createElement, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { useAgentOptionsByIds } from "@/lib/agent-options.query";

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderWithClient<T>(hook: () => T) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(hook, { wrapper });
}

const agentId = (i: number) =>
  `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

it("resolves more than 200 references in bounded ID batches with an explicit page size", async () => {
  const requests: URLSearchParams[] = [];
  server.use(
    http.get(`${API_ORIGIN}/api/agents/options`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      requests.push(query);
      return HttpResponse.json({
        data: (query.get("ids") ?? "")
          .split(",")
          .map((id) => ({ id, name: id })),
        pagination: { limit: 1000, hasNext: false, nextCursor: null },
      });
    }),
  );
  const ids = Array.from({ length: 201 }, (_, i) => agentId(i));
  const hook = renderWithClient(() =>
    useAgentOptionsByIds({ ids, filters: { agentType: "agent" } }),
  );
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(
    requests
      .map((query) => query.get("ids")?.split(",").length)
      .sort((a = 0, b = 0) => b - a),
  ).toEqual([200, 1]);
  for (const query of requests) {
    expect(query.get("agentType")).toBe("agent");
    expect(query.get("excludeBuiltIn")).toBe("false");
    expect(query.get("limit")).toBe("1000");
    expect(query.has("cursor")).toBe(false);
  }
  expect(hook.result.current.data?.map((row) => row.id)).toEqual(ids);
});

it("requests independent ID batches in parallel", async () => {
  // Each response waits until both batches have arrived, so sequential
  // batching would never finish.
  let arrived = 0;
  let releaseAll = () => {};
  const bothArrived = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  server.use(
    http.get(`${API_ORIGIN}/api/agents/options`, async ({ request }) => {
      const ids =
        new URL(request.url).searchParams.get("ids")?.split(",") ?? [];
      arrived += 1;
      if (arrived === 2) releaseAll();
      await bothArrived;
      return HttpResponse.json({
        data: ids.map((id) => ({ id, name: id })),
        pagination: { limit: 1000, hasNext: false, nextCursor: null },
      });
    }),
  );
  const ids = Array.from({ length: 201 }, (_, i) => agentId(i));
  const hook = renderWithClient(() => useAgentOptionsByIds({ ids }));
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(arrived).toBe(2);
  expect(hook.result.current.data?.map((row) => row.id)).toEqual(ids);
});

it("follows the next cursor until the batch is complete", async () => {
  const requests: URLSearchParams[] = [];
  server.use(
    http.get(`${API_ORIGIN}/api/agents/options`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      requests.push(query);
      const second = query.get("cursor") === "page-2";
      return HttpResponse.json({
        data: [{ id: second ? agentId(1) : agentId(0), name: "Agent" }],
        pagination: {
          limit: 1000,
          hasNext: !second,
          nextCursor: second ? null : "page-2",
        },
      });
    }),
  );
  const hook = renderWithClient(() =>
    useAgentOptionsByIds({ ids: [agentId(0), agentId(1)] }),
  );
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(requests.map((query) => query.get("cursor"))).toEqual([
    null,
    "page-2",
  ]);
  expect(
    requests.every((query) => query.get("ids")?.split(",").length === 2),
  ).toBe(true);
  expect(hook.result.current.data?.map((row) => row.id)).toEqual([
    agentId(0),
    agentId(1),
  ]);
});

it("returns one row per agent when pages repeat an agent", async () => {
  server.use(
    http.get(`${API_ORIGIN}/api/agents/options`, ({ request }) => {
      const second =
        new URL(request.url).searchParams.get("cursor") === "page-2";
      return HttpResponse.json({
        data: second
          ? [
              { id: agentId(0), name: "Agent 0" },
              { id: agentId(1), name: "Agent 1" },
            ]
          : [{ id: agentId(0), name: "Agent 0" }],
        pagination: {
          limit: 1000,
          hasNext: !second,
          nextCursor: second ? null : "page-2",
        },
      });
    }),
  );
  const hook = renderWithClient(() =>
    useAgentOptionsByIds({ ids: [agentId(0), agentId(1)] }),
  );
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(hook.result.current.data?.map((row) => row.id)).toEqual([
    agentId(0),
    agentId(1),
  ]);
});

it("never requests the roster without IDs", async () => {
  let requests = 0;
  server.use(
    http.get(`${API_ORIGIN}/api/agents/options`, () => {
      requests++;
      return HttpResponse.json([{ id: "unrequested-agent" }]);
    }),
  );
  const hook = renderWithClient(() => useAgentOptionsByIds({ ids: [] }));
  // Disabled without IDs: idle and still pending, so callers must not wait on it.
  expect(hook.result.current.fetchStatus).toBe("idle");
  expect(hook.result.current.isPending).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(requests).toBe(0);
});

it("keeps the resolved rows on screen while a changed id list loads", async () => {
  let releaseSecond = () => {};
  const secondHeld = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  server.use(
    http.get(`${API_ORIGIN}/api/agents/options`, async ({ request }) => {
      const ids =
        new URL(request.url).searchParams.get("ids")?.split(",") ?? [];
      if (ids.length > 1) await secondHeld;
      return HttpResponse.json({
        data: ids.map((id) => ({ id, name: id })),
        pagination: { limit: 1000, hasNext: false, nextCursor: null },
      });
    }),
  );
  let ids = [agentId(0)];
  const hook = renderWithClient(() =>
    useAgentOptionsByIds({ ids, keepPreviousData: true }),
  );
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));

  ids = [agentId(0), agentId(1)];
  hook.rerender();
  await waitFor(() => expect(hook.result.current.isFetching).toBe(true));
  expect(hook.result.current.isPlaceholderData).toBe(true);
  expect(hook.result.current.data?.map((row) => row.id)).toEqual([agentId(0)]);

  releaseSecond();
  await waitFor(() =>
    expect(hook.result.current.data?.map((row) => row.id)).toEqual([
      agentId(0),
      agentId(1),
    ]),
  );
  expect(hook.result.current.isPlaceholderData).toBe(false);
});
