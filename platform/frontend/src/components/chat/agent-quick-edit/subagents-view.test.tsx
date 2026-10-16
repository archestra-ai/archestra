import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { SubagentsView } from "./subagents-view";

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

it("loads tools only for visible rows and keeps selections while paging and searching the full roster", async () => {
  const agents = Array.from({ length: 45 }, (_, index) => ({
    id: `agent-${index}`,
    name: `Agent ${String(index).padStart(2, "0")}`,
    agentType: "agent",
    description: "Delegation target",
  }));
  const toolRequests = new Set<string>();
  const saved: string[][] = [];
  server.use(
    http.get(`${origin}/api/agents/options/page`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      expect(params.get("limit")).toBe("20");
      expect(params.get("excludeIds")).toBe("source");
      const search = params.get("search")?.toLowerCase() ?? "";
      const filtered = agents.filter(
        (agent) =>
          agent.name.toLowerCase().includes(search) ||
          agent.description.toLowerCase().includes(search),
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
    http.get(`${origin}/api/agents/source/delegations`, () =>
      HttpResponse.json([{ id: "agent-44" }]),
    ),
    http.get(`${origin}/api/internal_mcp_catalog`, () => HttpResponse.json([])),
    http.get(`${origin}/api/agent-tools`, ({ request }) => {
      const agentId = new URL(request.url).searchParams.get("agentId");
      expect(agentId).toBeTruthy();
      if (agentId) toolRequests.add(agentId);
      return HttpResponse.json({
        data: [],
        pagination: {
          total: 0,
          currentPage: 1,
          limit: 20,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      });
    }),
    http.post(
      `${origin}/api/agents/source/delegations`,
      async ({ request }) => {
        saved.push(
          ((await request.json()) as { targetAgentIds: string[] })
            .targetAgentIds,
        );
        return HttpResponse.json([]);
      },
    ),
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Dialog open>
        <DialogContent>
          <SubagentsView
            agentId="source"
            agentName="Source"
            onBack={() => {}}
          />
        </DialogContent>
      </Dialog>
    </QueryClientProvider>,
  );
  await screen.findByRole("checkbox", { name: /Agent 00/ });
  await waitFor(() => expect(toolRequests.size).toBe(20));
  expect(screen.getAllByRole("checkbox")).toHaveLength(20);
  expect(toolRequests.has("agent-42")).toBe(false);
  expect(
    screen.getByRole("button", { name: "Previous agents" }),
  ).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Next agents" }));
  const nextChoice = await screen.findByRole("checkbox", { name: /Agent 20/ });
  await userEvent.click(nextChoice);
  await waitFor(() => expect(toolRequests.size).toBe(40));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Search agents" }),
    "Agent 42",
  );
  expect(
    await screen.findByRole("checkbox", { name: /Agent 42/ }),
  ).toBeVisible();
  await waitFor(() => expect(toolRequests.has("agent-42")).toBe(true));
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(
    await screen.findByRole("checkbox", { name: /Agent 00/ }),
  ).not.toBeChecked();
  expect(screen.getByText(/2 selected/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Previous agents" }),
  ).toBeDisabled();
  await userEvent.type(
    screen.getByRole("textbox", { name: "Search agents" }),
    "Agent 44",
  );
  const savedChoice = await screen.findByRole("checkbox", { name: /Agent 44/ });
  expect(savedChoice).toBeChecked();
  await userEvent.click(savedChoice);
  await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toEqual(["agent-20"]);
  queryClient.clear();
});
