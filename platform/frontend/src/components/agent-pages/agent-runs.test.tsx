import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type AgentRunListItem,
  useShareAgentRun,
  useUnshareAgentRun,
} from "@/lib/agent-runtime.query";
import { useSession } from "@/lib/auth/auth.query";

const state = { runs: [] as AgentRunListItem[] };
const server = setupServer(
  http.get("http://localhost:9000/api/agents/:agentId/runs", () =>
    HttpResponse.json(state.runs),
  ),
);
let queryClient: QueryClient;

vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");

vi.mock("@/components/agent-run-state", () => ({
  AgentRunState: () => <span>Run state</span>,
}));

vi.mock("@/components/agent-run-terminal", () => ({
  AgentRunTerminal: () => <div>Live terminal</div>,
}));

vi.mock("@/components/agent-run-logs", () => ({
  AgentRunLogs: () => <div>Retained output</div>,
}));

import { AgentRuns } from "./agent-runs";

describe("AgentRuns", () => {
  beforeAll(() => {
    archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
    server.listen({ onUnhandledRequest: "error" });
  });
  afterEach(() => {
    queryClient.clear();
    server.resetHandlers();
  });
  afterAll(() => server.close());
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as ReturnType<typeof useSession>);
    state.runs = [createRun(null)];
  });

  it("shows the live terminal while a run is active and retained output when it ends", async () => {
    renderRuns();

    expect(await screen.findByText("Live terminal")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Chat" })).toBeNull();

    expect(screen.queryByRole("button", { name: "Output" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();

    state.runs = [createRun("2026-09-03T20:00:05.000Z")];
    await act(() => queryClient.invalidateQueries());

    expect(await screen.findByText("Retained output")).toBeInTheDocument();
    expect(screen.queryByText("Live terminal")).toBeNull();
    expect(screen.queryByRole("button", { name: "Output" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
  });

  it("identifies who started the selected run and who can see it", async () => {
    state.runs = [
      {
        ...createRun(null),
        initiatorName: "Alex Rivera",
        shareVisibility: "team",
        shareTeamNames: ["Platform", "Security"],
      },
    ];

    renderRuns();

    expect(
      await screen.findByText("Started by Alex Rivera (you)"),
    ).toBeVisible();
    expect(screen.getByLabelText("Team: Platform, Security")).toBeVisible();
  });

  it("labels an unshared run as personal without promising owner-only output access", async () => {
    renderRuns();

    expect(await screen.findByLabelText("Personal")).toBeVisible();
    fireEvent.focus(
      screen.getByRole("button", { name: "Who can access this run?" }),
    );
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Agent administrators can read output",
    );
  });

  it("switches owner and visibility with the selected run and keeps non-owners read-only", async () => {
    state.runs.push({
      ...createRun(null),
      id: "run-2",
      taskId: "22345678-abcd-4000-8000-123456789abc",
      actorUserId: "user-2",
      actorId: "user-2",
      initiatorName: "Sam Chen",
      title: "Shared review",
      shareVisibility: "organization",
    });
    renderRuns();
    expect(
      await screen.findByText("Started by Alex Rivera (you)"),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Shared review/ }));
    expect(screen.getByText("Started by Sam Chen")).toBeVisible();
    expect(screen.getByLabelText("Organization")).toBeVisible();
    expect(screen.getByText("Retained output")).toBeVisible();
    expect(screen.queryByText("Live terminal")).not.toBeInTheDocument();
  });

  it("shows named recipients instead of calling a user-shared run personal", async () => {
    state.runs = [
      {
        ...createRun(null),
        shareVisibility: "user",
        shareUserNames: ["Sam Chen", "Taylor Morgan"],
      },
    ];
    renderRuns();
    expect(
      await screen.findByLabelText("Shared with: Sam Chen, Taylor Morgan"),
    ).toBeVisible();
    expect(screen.queryByLabelText("Personal")).not.toBeInTheDocument();
  });

  it.each([
    "user",
    "team",
  ] as const)("keeps a redacted %s audience distinct from personal or empty sharing", async (shareVisibility) => {
    state.runs = [
      {
        ...createRun(null),
        actorUserId: "another-owner",
        shareVisibility,
        shareUserNames: null,
        shareTeamNames: null,
      },
    ];
    renderRuns();
    const badge = await screen.findByText(
      shareVisibility === "team" ? "Team" : "Shared",
      { exact: true },
    );
    expect(badge).toBeVisible();
    expect(screen.queryByText("No recipients")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Personal")).not.toBeInTheDocument();
    fireEvent.focus(badge);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Only the run owner can see sharing recipients.",
    );
  });

  it("refreshes the visible audience as soon as sharing is changed or removed", async () => {
    server.use(
      http.put("http://localhost:9000/api/agent-runs/:taskId/share", () => {
        state.runs = [{ ...state.runs[0], shareVisibility: "organization" }];
        return HttpResponse.json({ visibility: "organization" });
      }),
      http.delete("http://localhost:9000/api/agent-runs/:taskId/share", () => {
        state.runs = [{ ...state.runs[0], shareVisibility: null }];
        return HttpResponse.json({ success: true });
      }),
    );
    renderRuns();
    const { result } = renderHook(
      () => ({ share: useShareAgentRun(), unshare: useUnshareAgentRun() }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        ),
      },
    );
    expect(await screen.findByLabelText("Personal")).toBeVisible();
    await act(() =>
      result.current.share.mutateAsync({
        taskId: state.runs[0].taskId,
        visibility: "organization",
      }),
    );
    expect(await screen.findByLabelText("Organization")).toBeVisible();
    await act(() => result.current.unshare.mutateAsync(state.runs[0].taskId));
    expect(await screen.findByLabelText("Personal")).toBeVisible();
  });

  it("identifies additional project access without treating it as a run share", async () => {
    state.runs = [{ ...createRun(null), projectId: "project-1" }];
    renderRuns();
    expect(await screen.findByText("+ project access")).toBeVisible();
    fireEvent.focus(
      screen.getByRole("button", { name: "Who can access this run?" }),
    );
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "permission to read all project sessions",
    );
  });

  it.each([
    "user",
    "team",
  ] as const)("does not imply access when a %s share has no remaining recipients", async (shareVisibility) => {
    state.runs = [{ ...createRun(null), shareVisibility }];
    renderRuns();
    expect(await screen.findByText("No recipients")).toBeVisible();
    expect(screen.queryByLabelText("Personal")).not.toBeInTheDocument();
  });

  it("identifies automation when no initiating user exists", async () => {
    state.runs = [
      {
        ...createRun(null),
        actorKind: "system",
        actorUserId: null,
        initiatorName: null,
      },
    ];
    renderRuns();
    expect(await screen.findByText("Started by automation")).toBeVisible();
  });
  it("links an empty run history to a new Chat with this Agent selected", async () => {
    state.runs = [];

    renderRuns("agent/with spaces");

    expect(await screen.findByRole("link", { name: "Chat" })).toHaveAttribute(
      "href",
      "/chat/new?agent_id=agent%2Fwith%20spaces",
    );
  });
});

function renderRuns(agentId = "agent-1") {
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentRuns agentId={agentId} />
    </QueryClientProvider>,
  );
}

function createRun(endedAt: string | null): AgentRunListItem {
  return {
    id: "run-1",
    organizationId: "org-1",
    taskId: "12345678-abcd-4000-8000-123456789abc",
    agentId: "agent-1",
    actorKind: "user",
    actorId: "user-1",
    actorUserId: "user-1",
    title: "Native TUI verification",
    pinnedAt: null,
    projectId: null,
    workloadName: "agent-agent-1-task-1",
    backend: "kubernetes",
    runtimeScope: "archestra-dev",
    virtualApiKeyId: null,
    startedAt: "2026-09-03T20:00:00.000Z",
    hardDeadlineAt: "2026-09-06T20:00:00.000Z",
    lastModelActivityAt: "2026-09-03T20:00:04.000Z",
    attentionState: null,
    endedAt,
    state: endedAt ? "TASK_STATE_COMPLETED" : "TASK_STATE_WORKING",
    statusReason: null,
    stateChangedAt: "2026-09-03T20:00:05.000Z",
    initiatorName: "Alex Rivera",
    shareVisibility: null,
    shareTeamNames: [],
    shareUserNames: [],
  };
}
