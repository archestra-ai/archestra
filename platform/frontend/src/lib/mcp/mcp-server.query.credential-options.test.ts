import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { createElement, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { authQueryKeys } from "@/lib/auth/auth.query";
import { useMcpServersGroupedByCatalog } from "./mcp-server.query";

const API_ORIGIN = "http://localhost:9000";
const server = setupServer();
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it("loads credential options without agent assignments while retaining filters and owner ordering", async () => {
  const requests: URL[] = [];
  const shared = {
    id: "shared",
    name: "Shared credential",
    catalogId: "catalog-1",
    ownerId: "other",
    assignedAgents: [],
  };
  const owned = {
    ...shared,
    id: "owned",
    name: "Own credential",
    ownerId: "viewer",
  };
  server.use(
    http.get(`${API_ORIGIN}/api/mcp_server`, ({ request }) => {
      requests.push(new URL(request.url));
      return HttpResponse.json([shared, owned]);
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000, retry: false } },
  });
  queryClient.setQueryData(authQueryKeys.session(), { user: { id: "viewer" } });
  queryClient.setQueryData(authQueryKeys.userPermissions(), {
    mcpServerInstallation: ["read"],
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const hook = renderHook(
    () =>
      useMcpServersGroupedByCatalog({
        catalogId: "catalog-1",
        assignmentScope: "team",
        assignmentTeamIds: ["team-1"],
      }),
    { wrapper },
  );
  await waitFor(() =>
    expect(hook.result.current["catalog-1"]).toEqual([owned, shared]),
  );
  expect(requests).toHaveLength(1);
  expect(requests[0].searchParams.get("includeAssignedAgents")).toBe("false");
  expect(requests[0].searchParams.get("catalogId")).toBe("catalog-1");
  expect(requests[0].searchParams.get("assignmentScope")).toBe("team");
  expect(requests[0].searchParams.getAll("assignmentTeamIds")).toEqual([
    "team-1",
  ]);
  hook.unmount();
  queryClient.clear();
});
