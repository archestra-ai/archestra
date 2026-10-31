import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { toast } from "sonner";
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
import { Button } from "@/components/ui/button";
import type { AgentRunListItem } from "@/lib/agent-runtime.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useConversationSearch } from "@/lib/chat/use-conversation-search";
import { copyToClipboard } from "@/lib/clipboard";

const state = { runs: [] as AgentRunListItem[] };
const server = setupServer(
  http.get("http://localhost:9000/api/config", () =>
    HttpResponse.json({ features: { encryptedChatEnabled: false } }),
  ),
  http.get("http://localhost:9000/api/agents/:agentId/runs", () =>
    HttpResponse.json(state.runs),
  ),
  http.get("http://localhost:9000/api/agent-runs/:taskId", ({ params }) => {
    const run = state.runs.find((run) => run.taskId === params.taskId);
    return HttpResponse.json(
      run
        ? {
            ...run,
            agent: { id: "agent-1", name: "Maintenance Agent", icon: null },
            viewerRole: run.actorUserId === "user-1" ? "owner" : "shared",
            canAttach: run.canAttach ?? run.actorUserId === "user-1",
          }
        : null,
    );
  }),
  http.get("http://localhost:9000/api/projects/:id", ({ params }) =>
    HttpResponse.json({ id: params.id, name: "Engineering" }),
  ),
  http.get("http://localhost:9000/api/agent-runs/:taskId/permissions", () =>
    HttpResponse.json({ visibility: "private", teams: [], users: [] }),
  ),
);
let queryClient: QueryClient;
vi.mock("@/lib/auth/auth.query");
vi.mock("next/navigation");
vi.mock("sonner");
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}));
// Terminal process boundaries are covered by their own WebSocket suites.
vi.mock("@/components/agent-run-terminal", () => ({
  AgentRunTerminal: ({
    taskId,
    onCommandChange,
  }: {
    taskId: string;
    onCommandChange?: (command: string) => void;
  }) => (
    <div>
      <span>Live terminal</span>
      <Button onClick={() => onCommandChange?.(`connect ${taskId}`)}>
        Publish terminal command
      </Button>
    </div>
  ),
}));
vi.mock("@/components/agent-run-logs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/agent-run-logs")>()),
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
    HTMLElement.prototype.scrollIntoView = vi.fn();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as ReturnType<typeof useSession>);
    vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
      typeof useHasPermissions
    >);
    state.runs = [createRun(null)];
  });
  it("shows the live terminal and refreshes to the recording when a run ends", async () => {
    renderRuns();
    expect(await screen.findByText("Live terminal")).toBeVisible();
    expect(
      await screen.findByRole("link", { name: "Open full view" }),
    ).toHaveAttribute("href", `/chat/runs/${state.runs[0].taskId}`);
    state.runs = [createRun("2026-09-03T20:00:05.000Z")];
    await act(() => queryClient.invalidateQueries());
    expect(await screen.findByText("Retained output")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
  it("confirms stopping the selected run and refreshes its recording", async () => {
    const user = userEvent.setup();
    let requests = 0;
    server.use(
      http.post(
        "http://localhost:9000/api/agent-runs/:taskId/cancel",
        ({ params }) => {
          expect(params.taskId).toBe(state.runs[0].taskId);
          requests++;
          state.runs = [createRun("2026-09-03T20:00:05.000Z")];
          return HttpResponse.json({ success: true });
        },
      ),
    );
    renderRuns();
    await user.click(
      (await screen.findAllByRole("button", { name: "Stop" }))[0],
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(requests).toBe(0);
    await user.click(screen.getAllByRole("button", { name: "Stop" })[0]);
    await user.click(screen.getByRole("button", { name: "Stop run" }));
    expect(await screen.findByText("Retained output")).toBeVisible();
    expect(requests).toBe(1);
  });
  it("searches title, ID, and starter without replacing the selected run until a result is chosen", async () => {
    state.runs.push({
      ...createRun(null),
      taskId: "second-run",
      actorId: "user-2",
      actorUserId: "user-2",
      initiatorName: "Sam Chen",
      title: "Shared review",
    });
    renderRuns();
    const user = userEvent.setup();
    await user.click(
      (await screen.findAllByRole("button", { name: "Switch run" }))[0],
    );
    const dialog = screen.getByRole("dialog", { name: "Switch run" });
    const search = within(dialog).getByRole("textbox", {
      name: "Search all runs",
    });
    await user.type(search, "sam");
    expect(within(dialog).getByText("1 matching run")).toBeVisible();
    expect(
      within(dialog).queryByRole("button", { name: /Native TUI/ }),
    ).toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Native TUI verification",
        hidden: true,
      }),
    ).toBeVisible();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByRole("heading", { name: "Shared review" }),
    ).toBeVisible();
    expect(screen.getByText("Retained output")).toBeVisible();
    expect(screen.queryByText("Live terminal")).toBeNull();
  });
  it("keeps distinct service accounts in the starter filter", async () => {
    state.runs = [
      {
        ...createRun(null),
        actorKind: "serviceAccount",
        actorId: "account-1",
        actorUserId: null,
        initiatorName: "Build automation",
        title: "Build run",
      },
      {
        ...createRun(null),
        taskId: "second-run",
        actorKind: "serviceAccount",
        actorId: "account-2",
        actorUserId: null,
        initiatorName: "Release automation",
        title: "Release run",
      },
    ];
    renderRuns();
    const user = userEvent.setup();
    await user.click(
      (await screen.findAllByRole("button", { name: "Switch run" }))[0],
    );
    screen.getByRole("combobox", { name: "Started by" }).focus();
    await user.keyboard("{ArrowDown}");
    await user.click(
      screen.getByRole("option", { name: "Release automation" }),
    );
    expect(screen.getByRole("button", { name: /Release run/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Build run/ })).toBeNull();
  });
  it("keeps global search on Ctrl+K and opens the run switcher on Ctrl+Shift+K", async () => {
    renderRuns("agent-1", true);
    await screen.findByRole("button", { name: "Details" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(
      screen.getByRole("dialog", { name: "Search conversations" }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Switch run" })).toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("dialog", { name: "Switch run" })).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "Search conversations" }),
    ).toBeNull();
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Search all runs" }),
      { key: "k", ctrlKey: true, shiftKey: true },
    );
    expect(screen.getByRole("dialog", { name: "Switch run" })).toBeVisible();
  });
  it("resets history and connection commands when selecting another live run", async () => {
    state.runs.push({
      ...createRun(null),
      taskId: "second-live",
      title: "Second live run",
    });
    renderRuns();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Publish terminal command" }),
    );
    await user.click(screen.getByRole("button", { name: "More run actions" }));
    expect(
      screen.getByRole("menuitem", { name: "View connection details" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("menuitem", { name: "Run history" }));
    expect(screen.getByText("Retained output")).toBeVisible();
    await user.click(screen.getAllByRole("button", { name: "Switch run" })[0]);
    await user.click(screen.getByRole("button", { name: /Second live run/ }));
    await screen.findByRole("heading", { name: "Second live run" });
    expect(screen.getByText("Live terminal")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "More run actions" }));
    expect(
      screen.getByRole("menuitem", { name: "View connection details" }),
    ).toHaveAttribute("aria-disabled", "true");
  });
  it("reports a clipboard failure from the run actions menu", async () => {
    vi.mocked(copyToClipboard).mockRejectedValueOnce(
      new Error("Clipboard unavailable"),
    );
    renderRuns();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "More run actions" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Copy run ID" }));
    expect(toast.error).toHaveBeenCalledWith("Could not copy run ID");
  });
  it("shows metadata only on demand and keeps the inspector open while paging", async () => {
    state.runs[0].projectId = "project-1";
    state.runs.push({
      ...createRun(null),
      taskId: "second-run",
      title: "Second run",
      actorUserId: "user-2",
      actorId: "user-2",
      initiatorName: "Sam Chen",
    });
    renderRuns();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Details" }));
    const drawer = screen.getByRole("complementary", { name: "Run details" });
    expect(within(drawer).getByText("You")).toBeVisible();
    expect(
      await within(drawer).findByRole("link", { name: "Engineering" }),
    ).toHaveAttribute("href", "/projects/project-1");
    expect(
      within(drawer).getByText(/permission to read all project sessions/),
    ).toBeVisible();
    expect(within(drawer).getByText("1 of 2")).toBeVisible();
    await user.click(
      within(drawer).getByRole("button", { name: "Copy to clipboard" }),
    );
    expect(copyToClipboard).toHaveBeenCalledWith(state.runs[0].taskId);
    await user.click(within(drawer).getByRole("button", { name: "Next run" }));
    expect(
      await screen.findByRole("heading", { name: "Second run" }),
    ).toBeVisible();
    expect(await screen.findByText("Sam Chen")).toBeVisible();
    expect(screen.getByText("2 of 2")).toBeVisible();
  });
  it("permits service-account terminal access without ownership actions", async () => {
    state.runs = [
      {
        ...createRun(null),
        actorKind: "serviceAccount",
        actorId: "account-1",
        actorUserId: null,
        initiatorName: "Build automation",
        canAttach: true,
      },
    ];
    renderRuns();
    expect(
      await screen.findByRole("button", { name: "More run actions" }),
    ).toBeVisible();
    expect(screen.getByText("Live terminal")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More run actions" }));
    expect(screen.queryByRole("menuitem", { name: "Share" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Run history" }));
    expect(screen.getByText("Retained output")).toBeVisible();
  });
  it("keeps viewers without terminal access read-only", async () => {
    state.runs = [
      {
        ...createRun(null),
        actorKind: "serviceAccount",
        actorId: "account-1",
        actorUserId: null,
        initiatorName: null,
        canAttach: false,
      },
    ];
    renderRuns();
    expect(await screen.findByText("Retained output")).toBeVisible();
    expect(screen.queryByText("Live terminal")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More run actions" }));
    expect(
      screen.getByRole("menuitem", { name: "Download logs" }),
    ).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Share" })).toBeNull();
  });
  it("links an empty run history to Chat with the Agent selected", async () => {
    state.runs = [];
    renderRuns("agent/with spaces");
    expect(await screen.findByRole("link", { name: "Chat" })).toHaveAttribute(
      "href",
      "/chat/new?agent_id=agent%2Fwith%20spaces",
    );
  });
});
function renderRuns(agentId = "agent-1", globalSearch = false) {
  return render(
    <QueryClientProvider client={queryClient}>
      {globalSearch && <GlobalSearchHarness />}
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
    runtimeLimits: null,
    actorUserId: "user-1",
    title: "Native TUI verification",
    pinnedAt: null,
    projectId: null,
    workloadName: "agent-agent-1-task-1",
    backend: "kubernetes",
    runtimeScope: "archestra-dev",
    virtualApiKeyId: null,
    gatewayTokenId: null,
    startedAt: "2026-09-03T20:00:00.000Z",
    hardDeadlineAt: "2026-09-06T20:00:00.000Z",
    lastModelActivityAt: "2026-09-03T20:00:04.000Z",
    attentionState: null,
    endedAt,
    state: endedAt ? "TASK_STATE_COMPLETED" : "TASK_STATE_WORKING",
    statusReason: null,
    failure: null,
    stateChangedAt: "2026-09-03T20:00:05.000Z",
    initiatorName: "Alex Rivera",
    shareVisibility: null,
    shareTeamNames: [],
    shareUserNames: [],
  };
}

function GlobalSearchHarness() {
  const { isOpen } = useConversationSearch();
  return isOpen ? (
    <div role="dialog" aria-label="Search conversations" />
  ) : null;
}
