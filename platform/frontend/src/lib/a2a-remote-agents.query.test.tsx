import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { useA2aRemoteAgents } from "./a2a-remote-agents.query";

const API_ORIGIN = "http://localhost:9000";
const REGISTRY_URL = `${API_ORIGIN}/api/a2a/remote-agents`;
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: API_ORIGIN });
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

it("keeps manager and accessible-only agent lists in separate caches", async () => {
  const requests: string[] = [];
  server.use(
    http.get(REGISTRY_URL, ({ request }) => {
      const url = new URL(request.url);
      requests.push(url.search);
      const accessibleOnly = url.searchParams.get("accessibleOnly") === "true";
      return HttpResponse.json(
        accessibleOnly
          ? [{ id: "accessible", name: "Accessible Agent" }]
          : [{ id: "manager-only", name: "Manager-only Agent" }],
      );
    }),
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const manager = renderHook(() => useA2aRemoteAgents(), { wrapper });
  const assignment = renderHook(
    () => useA2aRemoteAgents({ accessibleOnly: true }),
    { wrapper },
  );

  await waitFor(() => {
    expect(manager.result.current.data?.[0]?.name).toBe("Manager-only Agent");
    expect(assignment.result.current.data?.[0]?.name).toBe("Accessible Agent");
  });
  expect(requests).toEqual(
    expect.arrayContaining(["", "?accessibleOnly=true"]),
  );
});
