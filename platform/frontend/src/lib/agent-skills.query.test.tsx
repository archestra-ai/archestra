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
  it("loads the Default environment for a new agent without an id", async () => {
    let requestedUrl: URL | undefined;
    server.use(
      http.get(`${API_ORIGIN}/api/agents/activation-skills`, ({ request }) => {
        requestedUrl = new URL(request.url);
        return HttpResponse.json({ enabled: true, skills: [] });
      }),
    );

    const { result } = renderHook(
      () => useAgentActivationSkills({ environmentId: undefined }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestedUrl?.search).toBe("");
    expect(result.current.data).toEqual({ enabled: true, skills: [] });
  });
});
