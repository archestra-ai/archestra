import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { type ReactNode, useState } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  SYNTHETIC_SCHEDULES,
  syntheticRunPage,
} from "@/mocks/data/scheduled-runs";
import {
  type ScheduleTriggerRunKind,
  type ScheduleTriggerRunStatus,
  useInfiniteScheduleTriggerRuns,
} from "./schedule-trigger.query";

const origin = "http://localhost:9000";
const id = SYNTHETIC_SCHEDULES[0].id;
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => archestraApiClient.setConfig({ baseUrl: origin }));
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function Wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

it("loads only requested pages of a thousand executions and resets pagination for filters", async () => {
  const requests: URL[] = [];
  server.use(
    http.get(`${origin}/api/schedule-triggers/:id/runs`, ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      const q = url.searchParams;
      return HttpResponse.json(
        syntheticRunPage(
          id,
          Number(q.get("limit")),
          Number(q.get("offset")),
          q.get("status") ?? undefined,
          q.get("runKind") ?? undefined,
        ),
      );
    }),
  );
  const { result, rerender, unmount } = renderHook(
    (filters: {
      status?: ScheduleTriggerRunStatus;
      runKind?: ScheduleTriggerRunKind;
    }) => useInfiniteScheduleTriggerRuns(id, filters),
    { initialProps: {}, wrapper: Wrapper },
  );
  await waitFor(() =>
    expect(result.current.data?.pages[0].data).toHaveLength(25),
  );
  expect(result.current.data?.pages[0].pagination.total).toBe(1000);
  expect(requests).toHaveLength(1);
  await act(async () => {
    await result.current.fetchNextPage();
  });
  await waitFor(() =>
    expect(
      result.current.data?.pages.flatMap((page) => page.data),
    ).toHaveLength(50),
  );
  expect(requests.map((url) => url.searchParams.get("offset"))).toEqual([
    "0",
    "25",
  ]);
  expect(requests.every((url) => url.searchParams.get("limit") === "25")).toBe(
    true,
  );
  rerender({ runKind: "manual" });
  await waitFor(() =>
    expect(result.current.data?.pages[0].pagination.total).toBe(100),
  );
  expect(
    result.current.data?.pages[0].data.every((run) => run.runKind === "manual"),
  ).toBe(true);
  expect(requests.at(-1)?.searchParams.get("offset")).toBe("0");
  rerender({ status: "failed" });
  await waitFor(() =>
    expect(result.current.data?.pages[0].pagination.total).toBe(200),
  );
  expect(
    result.current.data?.pages[0].data.every((run) => run.status === "failed"),
  ).toBe(true);
  expect(requests.at(-1)?.searchParams.get("offset")).toBe("0");
  unmount();
});
