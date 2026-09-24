import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { useAllCoverageToolsForCatalogs } from "./openappa-coverage.query";

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

test("combines every page from selected catalogs in catalog order", async () => {
  const requests: string[] = [];
  server.use(
    http.get(`${API_ORIGIN}/api/openappa/coverage/tools`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const catalogId = params.get("catalogId");
      const offset = params.get("offset");
      requests.push(`${catalogId}:${offset}`);
      const toolId = `${catalogId}-${offset}`;
      const hasNext = catalogId === "first" && offset === "0";
      return HttpResponse.json({
        data: [{ toolId, catalogId, fullName: toolId }],
        pagination: { hasNext },
      });
    }),
  );

  const { result } = renderHook(
    () => useAllCoverageToolsForCatalogs(["first", "second"]),
    { wrapper },
  );

  await waitFor(() => expect(result.current.isPending).toBe(false));
  expect(result.current.isError).toBe(false);
  expect(result.current.tools.map((tool) => tool.toolId)).toEqual([
    "first-0",
    "first-100",
    "second-0",
  ]);
  expect(requests.sort()).toEqual(["first:0", "first:100", "second:0"]);
});
