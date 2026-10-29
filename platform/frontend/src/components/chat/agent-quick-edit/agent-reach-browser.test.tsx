import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { AgentReachBrowser } from "./agent-reach-browser";

vi.mock("next/navigation");
vi.mock("sonner");
const origin = "http://localhost:9000";
const server = setupServer();
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it("waits for browsing, then reaches every eligible agent through bounded pages and search", async () => {
  const requests: string[] = [];
  const agents = Array.from({ length: 43 }, (_, index) => ({
    id: `agent-${index}`,
    name: `Agent ${String(index).padStart(2, "0")}`,
    description: "Available target",
  }));
  server.use(
    http.get(`${origin}/api/agents/options/page`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      expect(params.get("limit")).toBe("20");
      expect(params.get("excludeIds")).toBe("source,excluded");
      requests.push(request.url);
      const filtered = agents.filter((agent) =>
        agent.name
          .toLowerCase()
          .includes(params.get("search")?.toLowerCase() ?? ""),
      );
      const offset = Number(params.get("cursor") ?? 0);
      return HttpResponse.json({
        data: filtered.slice(offset, offset + 20),
        pagination: {
          limit: 20,
          hasNext: offset + 20 < filtered.length,
          nextCursor:
            offset + 20 < filtered.length ? String(offset + 20) : null,
        },
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AgentReachBrowser agentId="source" excludedIds={["excluded"]} />
    </QueryClientProvider>,
  );
  expect(requests).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Browse agents" }));
  await screen.findByText("Agent 00");
  expect(screen.getAllByRole("listitem")).toHaveLength(20);
  expect(requests).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Next agents" }));
  await screen.findByText("Agent 20");
  expect(requests).toHaveLength(2);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Search available subagents" }),
    "Agent 42",
  );
  await screen.findByText("Agent 42");
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  await userEvent.clear(
    screen.getByRole("textbox", { name: "Search available subagents" }),
  );
  await waitFor(() => expect(screen.getByText("Agent 00")).toBeVisible());
  client.clear();
});
