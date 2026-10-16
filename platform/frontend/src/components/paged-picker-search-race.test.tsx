import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { AgentReachBrowser } from "@/components/chat/agent-quick-edit/agent-reach-browser";
import { SubagentsView } from "@/components/chat/agent-quick-edit/subagents-view";
import { RemoteUserSelect } from "@/components/remote-user-select";
import { Dialog, DialogContent } from "@/components/ui/dialog";

vi.mock("next/navigation");
vi.mock("sonner");
const origin = "http://localhost:9000";
const server = setupServer();
const clients: QueryClient[] = [];
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() =>
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  }),
);
afterEach(() => {
  for (const client of clients) client.clear();
  clients.length = 0;
  server.resetHandlers();
});
afterAll(() => server.close());

it.each([
  "member",
  "available",
  "subagent",
] as const)("keeps a cached search on its first page when an older %s Next request finishes", async (kind) => {
  let releaseNext!: () => void;
  let heldStarted = false;
  const heldNext = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  const choices = Array.from({ length: 45 }, (_, index) => ({
    id: `choice-${index}`,
    name: `Person ${String(index).padStart(2, "0")}`,
    email: `person-${index}@example.com`,
    agentType: "agent",
    description: "Available choice",
  }));
  const endpoint =
    kind === "member"
      ? "/api/organization/member-options"
      : "/api/agents/options/page";
  server.use(
    http.get(`${origin}${endpoint}`, async ({ request }) => {
      const params = new URL(request.url).searchParams;
      const search = params.get("search") ?? "";
      const offset = Number(params.get("cursor") ?? 0);
      if (!search && offset === 20) {
        heldStarted = true;
        await heldNext;
      }
      const filtered = choices.filter((choice) => choice.name.includes(search));
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
      HttpResponse.json([]),
    ),
    http.get(`${origin}/api/internal_mcp_catalog`, () => HttpResponse.json([])),
    http.get(`${origin}/api/agent-tools`, () =>
      HttpResponse.json({
        data: [],
        pagination: { hasNext: false, nextCursor: null },
      }),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <Dialog open>
        <DialogContent>
          {kind === "member" ? (
            <RemoteUserSelect
              value="all"
              pinnedOption={{ value: "all", label: "All Users" }}
              onValueChange={() => {}}
            />
          ) : kind === "available" ? (
            <AgentReachBrowser agentId="source" excludedIds={[]} />
          ) : (
            <SubagentsView
              agentId="source"
              agentName="Source"
              onBack={() => {}}
            />
          )}
        </DialogContent>
      </Dialog>
    </QueryClientProvider>,
  );
  if (kind === "member") await userEvent.click(screen.getByRole("combobox"));
  if (kind === "available")
    await userEvent.click(
      screen.getByRole("button", { name: "Browse agents" }),
    );
  const findChoice = (number: string) =>
    kind === "available"
      ? screen.findByText(`Person ${number}`)
      : screen.findByRole(kind === "member" ? "option" : "checkbox", {
          name: new RegExp(`Person ${number}`),
        });
  const queryChoice = (number: string) =>
    kind === "available"
      ? screen.queryByText(`Person ${number}`)
      : screen.queryByRole(kind === "member" ? "option" : "checkbox", {
          name: new RegExp(`Person ${number}`),
        });
  await findChoice("00");
  const searchInput =
    kind === "member"
      ? screen.getByPlaceholderText("Search users")
      : screen.getByRole("textbox", {
          name:
            kind === "available"
              ? "Search available subagents"
              : "Search agents",
        });
  const nextName = kind === "member" ? "Next users" : "Next agents";
  // First cache two pages of a search, then leave it for a different query.
  await userEvent.type(searchInput, "Person");
  await findChoice("00");
  await userEvent.click(screen.getByRole("button", { name: nextName }));
  await findChoice("20");
  await userEvent.clear(searchInput);
  await findChoice("00");
  await userEvent.click(screen.getByRole("button", { name: nextName }));
  await waitFor(() => expect(heldStarted).toBe(true));
  // Returning to the cached search must stay on its first page after the
  // older query finishes; it must not inherit that query's pending Next.
  await userEvent.type(searchInput, "Person");
  await findChoice("00");
  releaseNext();
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(await findChoice("00")).toBeVisible();
  expect(queryChoice("20")).not.toBeInTheDocument();
});
