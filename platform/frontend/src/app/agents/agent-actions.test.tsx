import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { makeAgent } from "@/mocks/data/agents";
import { AgentActions } from "./agent-actions";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/organization.query");

const origin = "http://localhost:9000";
const server = setupServer();
let preflightRequests: string[];

const runtime = {
  image: "example.com/runtime:1",
  command: ["archestra-codex"],
  inferenceProtocol: "openai_responses" as const,
  backend: "kubernetes" as const,
  steerMode: "pipe" as const,
  privileged: false,
  environment: null,
  credentials: null,
  ttlHours: null,
  idleTimeoutMinutes: null,
};
const agents = ["Reviewer", "Planner", "Tester"].map((name, index) =>
  makeAgent({ id: `agent-${index + 1}`, name, runtime }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
afterEach(() => server.resetHandlers());
beforeEach(() => {
  preflightRequests = [];
  archestraApiClient.setConfig({ baseUrl: origin });
  // The row's links prefetch their route on hover.
  vi.mocked(useRouter).mockReturnValue({ prefetch: vi.fn() } as never);
  vi.mocked(useFeature).mockReturnValue(true);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    missingPermissions: [],
  } as never);
  server.use(
    http.get(`${origin}/api/agents/:id/runtime/preflight`, ({ params }) => {
      preflightRequests.push(String(params.id));
      return HttpResponse.json({
        ready: false,
        configured: [],
        missing: [],
        misconfigured: [],
        incompatible: null,
        accountError: "Connect your ChatGPT subscription to run this agent.",
        accountErrorFromChoice: false,
        missingSubscription: "chatgpt",
      });
    }),
  );
});

function renderRows() {
  const noop = () => {};
  const handlers: Omit<
    ComponentProps<typeof AgentActions>,
    "agent" | "canModify"
  > = {
    onEdit: noop,
    onView: noop,
    onDelete: noop,
    onRestore: noop,
    onPermanentlyDelete: noop,
    onClone: noop,
    onExport: noop,
    onTogglePin: noop,
    onHistory: noop,
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      {agents.map((agent) => (
        <div key={agent.id} data-testid={agent.id}>
          <AgentActions agent={agent as never} canModify {...handlers} />
        </div>
      ))}
    </QueryClientProvider>,
  );
}

it("checks no agent's setup when the list loads, and one agent's once its actions are reached", async () => {
  const user = userEvent.setup();
  renderRows();

  // Every row offers its run, and none has asked whether it can start.
  for (const agent of agents) {
    expect(
      within(screen.getByTestId(agent.id)).getByRole("link", {
        name: `Start run ${agent.name}`,
      }),
    ).toBeVisible();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(preflightRequests).toEqual([]);

  // Reaching one row's actions checks that agent, and only that one.
  const second = within(screen.getByTestId("agent-2"));
  await user.hover(second.getByRole("link", { name: "Start run Planner" }));
  await waitFor(() => expect(preflightRequests).toEqual(["agent-2"]));
  // What stops the run replaces the link before it can be followed.
  await waitFor(() =>
    expect(
      second.queryByRole("link", { name: "Start run Planner" }),
    ).not.toBeInTheDocument(),
  );
  expect(preflightRequests).toEqual(["agent-2"]);
});

it("checks an agent's setup when the keyboard reaches its actions", async () => {
  const user = userEvent.setup();
  renderRows();
  expect(preflightRequests).toEqual([]);

  await user.tab();
  await waitFor(() => expect(preflightRequests).toEqual(["agent-1"]));
});
