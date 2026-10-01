import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { useRouter } from "next/navigation";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { AgentRunChatSession } from "./page.client";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");
// Terminal IO is a separate WebSocket boundary.
vi.mock("@/components/agent-run-terminal", () => ({
  AgentRunTerminal: ({ taskId }: { taskId: string }) => (
    <div>Live terminal {taskId}</div>
  ),
}));
vi.mock("@/components/agent-run-logs", () => ({
  AgentRunLogs: () => <div>Saved output</div>,
}));
vi.mock("@/components/chat/share-agent-run-dialog", () => ({
  ShareAgentRunDialog: () => null,
}));
const server = setupServer();
const origin = "http://localhost:9000";
const previous = {
  taskId: "previous",
  sessionId: "session",
  title: "Resume demo",
  viewerRole: "owner",
  state: "TASK_STATE_COMPLETED",
  endedAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  hardDeadlineAt: "2099-01-01T00:00:00Z",
  agent: { id: "agent", name: "Coding agent", icon: null },
  workspace: {
    state: "suspended",
    expiresAt: "2099-01-01T00:00:00Z",
    connection: null,
    idleAt: null,
  },
};
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
it("leaves the completed turn immediately after resume is accepted, even while session metadata is stale", async () => {
  const user = userEvent.setup();
  let requests = 0;
  let release!: () => void;
  const accepted = new Promise<void>((resolve) => {
    release = resolve;
  });
  let body: unknown;
  server.use(
    http.get(`${origin}/api/agent-runs/session`, () =>
      HttpResponse.json(previous),
    ),
    http.get(`${origin}/api/agent-runs/next`, () =>
      HttpResponse.json({
        ...previous,
        taskId: "next",
        state: "TASK_STATE_SUBMITTED",
        endedAt: null,
      }),
    ),
    http.get(`${origin}/api/agent-runs`, () =>
      HttpResponse.json({ data: [], pagination: {} }),
    ),
    http.post(
      `${origin}/api/agent-runs/session/continue`,
      async ({ request }) => {
        requests++;
        body = await request.json();
        await accepted;
        return HttpResponse.json({
          taskId: "next",
          sessionId: "session",
          state: "TASK_STATE_SUBMITTED",
        });
      },
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AgentRunChatSession taskId="session" />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "Resume" }));
  await waitFor(() => expect(requests).toBe(1));
  expect(body).toEqual({});
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  const resuming = screen.getByRole("button", { name: "Resuming…" });
  expect(resuming).toBeDisabled();
  await user.click(resuming);
  expect(requests).toBe(1);
  release();
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Resume" }),
    ).not.toBeInTheDocument(),
  );
  expect(await screen.findByText("Live terminal next")).toBeInTheDocument();
  client.clear();
});

it("allows retry after a resume request fails", async () => {
  const user = userEvent.setup();
  let requests = 0;
  server.use(
    http.get(`${origin}/api/agent-runs/session`, () =>
      HttpResponse.json(previous),
    ),
    http.post(`${origin}/api/agent-runs/session/continue`, () => {
      requests++;
      return HttpResponse.json(
        { error: { message: "Workspace is busy", type: "conflict" } },
        { status: 409 },
      );
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AgentRunChatSession taskId="session" />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "Resume" }));
  await waitFor(() => expect(requests).toBe(1));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled(),
  );
  expect(screen.getByText("Saved output")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Resume" }));
  await waitFor(() => expect(requests).toBe(2));
  client.clear();
});
