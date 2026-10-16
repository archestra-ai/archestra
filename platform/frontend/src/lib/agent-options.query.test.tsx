import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { useAgentOptions } from "./agent.query";

const origin = "http://localhost:9000";
const server = setupServer();
const agents = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Selected agent",
    slug: null,
    agentType: "agent",
    icon: null,
    scope: "org",
    authorId: null,
    authorName: null,
    authorEmail: null,
    isPersonalGateway: false,
    runtime: null,
    description: null,
    teams: [],
    users: [],
  },
];

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
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

it("shares one metadata request between equivalent singleton type selectors", async () => {
  let requests = 0;
  server.use(
    http.get(`${origin}/api/agents/options`, () => {
      requests++;
      return HttpResponse.json(agents);
    }),
  );
  const { result } = renderHook(
    () => ({
      singular: useAgentOptions({ filters: { agentType: "agent" } }),
      plural: useAgentOptions({ filters: { agentTypes: ["agent"] } }),
      explicit: useAgentOptions({
        filters: { agentType: "agent", agentTypes: ["agent"] },
      }),
    }),
    { wrapper },
  );
  await waitFor(() =>
    expect([
      result.current.singular.isSuccess,
      result.current.plural.isSuccess,
      result.current.explicit.isSuccess,
    ]).toEqual([true, true, true]),
  );
  expect(requests).toBe(1);
  expect(result.current.singular.data).toEqual(agents);
  expect(result.current.plural.data).toEqual(agents);
  expect(result.current.explicit.data).toEqual(agents);
});

it("preserves contradictory explicit filters instead of aliasing them to a singleton", async () => {
  const requests: URLSearchParams[] = [];
  server.use(
    http.get(`${origin}/api/agents/options`, ({ request }) => {
      requests.push(new URL(request.url).searchParams);
      return HttpResponse.json(agents);
    }),
  );
  const { result } = renderHook(
    () => ({
      singleton: useAgentOptions({ filters: { agentType: "agent" } }),
      contradictory: useAgentOptions({
        filters: { agentType: "profile", agentTypes: ["agent"] },
      }),
    }),
    { wrapper },
  );
  await waitFor(() =>
    expect(
      result.current.singleton.isSuccess &&
        result.current.contradictory.isSuccess,
    ).toBe(true),
  );
  expect(requests).toHaveLength(2);
  expect(
    requests.some(
      (query) =>
        query.get("agentType") === "profile" &&
        query.get("agentTypes") === "agent",
    ),
  ).toBe(true);
  expect(result.current.singleton.data).toEqual(agents);
  expect(result.current.contradictory.data).toEqual(agents);
});
