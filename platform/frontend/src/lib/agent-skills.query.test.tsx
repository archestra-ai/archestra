import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAgentActivationSkills } from "./agent-skills.query";

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

describe("useAgentActivationSkills", () => {
  it("loads a searchable page for a new agent in the Default environment", async () => {
    let requestedUrl: URL | undefined;
    server.use(
      http.get(`${API_ORIGIN}/api/agents/activation-skills`, ({ request }) => {
        requestedUrl = new URL(request.url);
        return HttpResponse.json({
          enabled: true,
          data: [],
          pagination: {
            currentPage: 2,
            limit: 10,
            total: 12,
            totalPages: 2,
            hasNext: false,
            hasPrev: true,
          },
        });
      }),
    );

    const { result } = renderHook(
      () =>
        useAgentActivationSkills({
          environmentId: undefined,
          limit: 10,
          offset: 10,
          search: "incident",
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestedUrl?.searchParams.get("agentId")).toBeNull();
    expect(requestedUrl?.searchParams.get("environmentId")).toBeNull();
    expect(requestedUrl?.searchParams.get("limit")).toBe("10");
    expect(requestedUrl?.searchParams.get("offset")).toBe("10");
    expect(requestedUrl?.searchParams.get("search")).toBe("incident");
    expect(result.current.data).toMatchObject({ enabled: true, data: [] });
  });
});
