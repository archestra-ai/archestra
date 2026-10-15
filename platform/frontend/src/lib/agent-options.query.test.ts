import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { createElement, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  useAgentOptions,
  useDelegationTargetAgents,
  useOrgScopedAgents,
  useProfile,
} from "@/lib/agent.query";

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it("loads delegation metadata only when enabled and never seeds editable settings from it", async () => {
  const requests: URL[] = [];
  const metadata = [
    {
      id: "agent-1",
      name: "Target",
      description: "A delegation target",
      agentType: "agent",
    },
  ];
  server.use(
    http.get(`${API_ORIGIN}/api/agents/options`, ({ request }) => {
      requests.push(new URL(request.url));
      return HttpResponse.json(metadata);
    }),
    http.get(`${API_ORIGIN}/api/agents/agent-1`, () =>
      HttpResponse.json({
        ...metadata[0],
        systemPrompt: "Full editable settings",
        tools: [{ id: "tool-1" }],
      }),
    ),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000, retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const roster = renderHook(
    ({ enabled }) => useDelegationTargetAgents({ enabled }),
    { wrapper, initialProps: { enabled: false } },
  );
  expect(roster.result.current.fetchStatus).toBe("idle");
  expect(requests).toHaveLength(0);
  roster.rerender({ enabled: true });
  await waitFor(() => expect(roster.result.current.data).toEqual(metadata));
  expect(requests).toHaveLength(1);
  expect(Object.fromEntries(requests[0].searchParams)).toEqual({
    agentType: "agent",
    excludeBuiltIn: "true",
  });
  const detail = renderHook(() => useProfile("agent-1"), { wrapper });
  expect(detail.result.current.data).toBeUndefined();
  await waitFor(() =>
    expect(detail.result.current.data?.systemPrompt).toBe(
      "Full editable settings",
    ),
  );
  expect(detail.result.current.data?.tools).toEqual([{ id: "tool-1" }]);
  roster.unmount();
  detail.unmount();
  queryClient.clear();
});

it("uses compact organization options for the default-agent selector", async () => {
  const requests: URL[] = [];
  const metadata = [
    { id: "org-agent", name: "Organization default", agentType: "agent" },
  ];
  server.use(
    http.get(`${API_ORIGIN}/api/agents/options`, ({ request }) => {
      requests.push(new URL(request.url));
      return HttpResponse.json(metadata);
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const hook = renderHook(() => useOrgScopedAgents(), { wrapper });
  await waitFor(() => expect(hook.result.current.data).toEqual(metadata));
  expect(Object.fromEntries(requests[0].searchParams)).toEqual({
    agentType: "agent",
    excludeBuiltIn: "true",
    scope: "org",
  });
  hook.unmount();
  queryClient.clear();
});

it("treats an explicitly empty ID selection as empty without requesting the whole roster", async () => {
  let requests = 0;
  server.use(
    http.get(`${API_ORIGIN}/api/agents/options`, () => {
      requests++;
      return HttpResponse.json([{ id: "unrequested-agent" }]);
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const hook = renderHook(
    () => useAgentOptions({ filters: { ids: [] }, enabled: true }),
    { wrapper },
  );
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(hook.result.current.data).toEqual([]);
  expect(requests).toBe(0);
  hook.unmount();
  queryClient.clear();
});
