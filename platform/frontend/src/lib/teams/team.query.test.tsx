import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useMyTeams } from "./team.query";

const origin = "http://localhost:9000";
const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: origin });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

describe("useMyTeams", () => {
  it("reads every team the viewer belongs to, past the first page", async () => {
    const teams = Array.from({ length: 150 }, (_, i) => ({
      id: `team-${i}`,
      name: `Team ${i}`,
    }));
    const offsets: number[] = [];
    server.use(
      http.get(`${origin}/api/teams`, ({ request }) => {
        const url = new URL(request.url);
        const offset = Number(url.searchParams.get("offset"));
        const limit = Number(url.searchParams.get("limit"));
        offsets.push(offset);
        return HttpResponse.json({
          data: teams.slice(offset, offset + limit),
          pagination: { total: teams.length },
        });
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useMyTeams(), { wrapper });

    await waitFor(() => expect(result.current.data).toHaveLength(150));
    expect(offsets).toEqual([0, 100]);
  });
});
