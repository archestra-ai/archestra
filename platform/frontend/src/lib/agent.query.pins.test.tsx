import { archestraApiClient } from "@archestra/shared";
import {
  dehydrate,
  hydrate,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeAgent, makeAgentsList } from "@/mocks/data/agents";
import { useProfilesPaginated } from "./agent.query";

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();

beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("persisted pin sections", () => {
  it.each([
    true,
    false,
  ])("revalidates a fresh restored snapshot for pinned=%s", async (pinned) => {
    const gateway = makeAgent({ agentType: "mcp_gateway" });
    let rows = [gateway];
    server.use(
      http.get(`${API_ORIGIN}/api/agents`, () =>
        HttpResponse.json(makeAgentsList({ agents: rows })),
      ),
    );
    const mount = (client: QueryClient) =>
      renderHook(
        () => useProfilesPaginated({ agentTypes: ["mcp_gateway"], pinned }),
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>
              {children}
            </QueryClientProvider>
          ),
        },
      );
    const options = {
      defaultOptions: { queries: { staleTime: 60_000, retry: false } },
    };
    const original = new QueryClient(options);
    const first = mount(original);
    await waitFor(() =>
      expect(first.result.current.data?.data).toHaveLength(1),
    );
    const snapshot = dehydrate(original);
    first.unmount();
    original.clear();

    // A pin/unpin completed, but a reload recovered the previous snapshot.
    rows = [];
    const restored = new QueryClient(options);
    hydrate(restored, snapshot);
    const second = mount(restored);
    await waitFor(() => expect(second.result.current.data?.data).toEqual([]));
    second.unmount();
    restored.clear();
  });
});
