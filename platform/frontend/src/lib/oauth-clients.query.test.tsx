import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { useOauthClientsForResource } from "./oauth-clients.query";

const origin = "http://localhost:9000";
const server = setupServer();
const RESOURCE_ID = "00000000-0000-4000-8000-0000000000aa";

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

it("asks the server for the resource's clients instead of walking every page", async () => {
  const queries: string[] = [];
  server.use(
    http.get(`${origin}/api/oauth-clients`, ({ request }) => {
      queries.push(new URL(request.url).search);
      return HttpResponse.json({
        data: [{ id: "client-1", name: "Assigned client" }],
        pagination: {
          currentPage: 1,
          limit: 100,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      });
    }),
  );

  const { result } = renderHook(
    () => useOauthClientsForResource({ resourceId: RESOURCE_ID }),
    { wrapper },
  );

  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.map((client) => client.name)).toEqual([
    "Assigned client",
  ]);
  expect(queries).toEqual([`?applicableTo=${RESOURCE_ID}&limit=100&offset=0`]);
});
