import type { ServerWebSocketMessage } from "@archestra/shared";
import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  screen,
  render as testingRender,
  waitFor,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
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
import type { AgentRun } from "@/lib/agent-runtime.query";
import { ChatProvider } from "@/lib/chat/global-chat.context";

vi.mock("next/navigation");
vi.mock("sonner");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/organization.query");

import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useConfig, usePublicConfig } from "@/lib/config/config.query";
import {
  useAppearanceSettings,
  useIsGlobalAdmin,
  useOrganization,
} from "@/lib/organization.query";

const server = setupServer(
  ...[
    "/api/agents/test-agent",
    "/api/profiles/test-agent/tools",
    "/api/internal-mcp-catalog",
    "/api/llm-provider-api-keys",
    "/api/llm-models/available",
    "/api/skills",
    "/api/agents",
    "/api/chat/conversations",
    "/api/chat/agents/test-agent/mcp-tools",
  ].map((path) =>
    http.get(`http://localhost:9000${path}`, () => HttpResponse.json([])),
  ),
);
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: "http://localhost:9000" });
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => server.close());
afterEach(() => server.resetHandlers());
function render(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return testingRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <ChatProvider>{children}</ChatProvider>
      </QueryClientProvider>
    ),
  });
}

const socket = vi.hoisted(() => {
  const handlers = new Map<string, (message: ServerWebSocketMessage) => void>();
  return {
    handlers,
    connect: vi.fn(),
    isConnected: vi.fn(() => true),
    onConnectionChange: vi.fn(() => () => {}),
    send: vi.fn(),
    subscribe: vi.fn(
      (type: string, handler: (message: ServerWebSocketMessage) => void) => {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
    ),
  };
});

vi.mock("@/lib/websocket/websocket", () => ({ default: socket }));
vi.mock("@/components/terminal-playback", () => ({
  TerminalPlayback: ({ content }: { content: string }) => (
    <pre data-testid="terminal-playback">{content}</pre>
  ),
}));

import { AgentRunLogs } from "./agent-run-logs";

describe("AgentRunLogs", () => {
  beforeEach(() => {
    vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
      typeof useHasPermissions
    >);
    vi.mocked(useSession).mockReturnValue({ data: null } as ReturnType<
      typeof useSession
    >);
    vi.mocked(useOrganization).mockReturnValue({
      data: undefined,
    } as ReturnType<typeof useOrganization>);
    vi.mocked(useAppearanceSettings).mockReturnValue({
      data: undefined,
    } as ReturnType<typeof useAppearanceSettings>);
    vi.mocked(useIsGlobalAdmin).mockReturnValue({
      isGlobalAdmin: false,
      isLoading: false,
    });
    vi.mocked(useConfig).mockReturnValue({ data: undefined } as ReturnType<
      typeof useConfig
    >);
    vi.mocked(usePublicConfig).mockReturnValue({
      data: undefined,
    } as ReturnType<typeof usePublicConfig>);
    socket.handlers.clear();
    socket.connect.mockClear();
    socket.send.mockClear();
    socket.subscribe.mockClear();
  });

  it("renders all received transcript chunks and labels a complete recording", () => {
    render(<AgentRunLogs run={completedRun} />);

    emit({
      type: "agent_run_logs",
      payload: { runId: "task-1", logs: "first chunk\n" },
    });
    emit({
      type: "agent_run_logs",
      payload: { runId: "task-1", logs: "second chunk\n" },
    });
    emit({
      type: "agent_run_logs_ended",
      payload: {
        runId: "task-1",
        source: "full",
        truncated: false,
        totalBytes: 25,
      },
    });

    expect(screen.getByTestId("terminal-playback")).toHaveTextContent(
      "first chunk second chunk",
    );
    expect(screen.getByText("Complete terminal recording")).toBeInTheDocument();
  });

  it("renders session history delivered to the stable URL after a continuation", () => {
    render(<AgentRunLogs run={completedRun} sessionId="original-session" />);
    emit({
      type: "agent_run_logs",
      payload: { runId: "original-session", logs: "Earlier turn output\n" },
    });
    emit({
      type: "agent_run_logs",
      payload: { runId: "unrelated-session", logs: "Private unrelated output" },
    });
    emit({
      type: "agent_run_logs",
      payload: { runId: "original-session", logs: "Continuation output\n" },
    });
    expect(screen.getByTestId("terminal-playback")).toHaveTextContent(
      "Earlier turn output Continuation output",
    );
    expect(
      screen.queryByText(/Private unrelated output/),
    ).not.toBeInTheDocument();
  });

  it("warns when only the bounded tail could be retained", () => {
    render(<AgentRunLogs run={completedRun} />);

    emit({
      type: "agent_run_logs",
      payload: { runId: "task-1", logs: "last available output" },
    });
    emit({
      type: "agent_run_logs_ended",
      payload: {
        runId: "task-1",
        source: "tail",
        truncated: true,
        totalBytes: 300_000_000,
      },
    });

    expect(
      screen.getByText("Retained tail only").parentElement,
    ).toHaveAttribute(
      "title",
      "The complete transcript exceeded this deployment's storage limit.",
    );
  });

  it("retries when completed metadata arrives before retained output", async () => {
    render(<AgentRunLogs run={completedRun} />);
    expect(socket.send).toHaveBeenCalledTimes(1);

    emit({
      type: "agent_run_logs_ended",
      payload: {
        runId: "task-1",
        source: "tail",
        truncated: false,
      },
    });

    await waitFor(() => expect(socket.send).toHaveBeenCalledTimes(2));
    expect(socket.send).toHaveBeenLastCalledWith({
      type: "subscribe_agent_run_logs",
      payload: { runId: "task-1" },
    });

    emit({
      type: "agent_run_logs",
      payload: { runId: "task-1", logs: "retained output" },
    });
    emit({
      type: "agent_run_logs_ended",
      payload: {
        runId: "task-1",
        source: "full",
        truncated: false,
        totalBytes: 15,
      },
    });

    expect(screen.getByTestId("terminal-playback")).toHaveTextContent(
      "retained output",
    );
    expect(screen.getByText("Complete terminal recording")).toBeInTheDocument();
  });

  it("renders native events with the shared chat renderer without switching to terminal output", () => {
    render(<AgentRunLogs run={completedRun} />);
    emit({
      type: "agent_run_session",
      payload: {
        runId: "task-1",
        transcript: {
          version: 1,
          provider: "codex",
          entries: [
            { type: "message", role: "assistant", text: "Start of the run" },
          ],
        },
      },
    });
    expect(screen.getByText("Start of the run")).toBeInTheDocument();
    emit({
      type: "agent_run_logs",
      payload: { runId: "task-1", logs: "diagnostic output" },
    });
    expect(screen.getByText("Start of the run")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("keeps replay usable until a chunked readable transcript is complete", async () => {
    const { rerender } = render(<AgentRunLogs run={completedRun} />);
    emit({
      type: "agent_run_logs",
      payload: { runId: "task-1", logs: "recorded output" },
    });
    const readable = JSON.stringify({
      version: 1,
      provider: "codex",
      entries: [
        {
          type: "message",
          role: "assistant",
          text: "A full-width answer from a phone run",
        },
      ],
    });
    emit({
      type: "agent_run_logs",
      payload: {
        runId: "task-1",
        channel: "readable",
        logs: readable.slice(0, 50),
      },
    });
    expect(screen.getByTestId("terminal-playback")).toHaveTextContent(
      "recorded output",
    );
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    emit({
      type: "agent_run_logs",
      payload: {
        runId: "task-1",
        channel: "readable",
        logs: readable.slice(50),
      },
    });
    expect(screen.getByText(/A full-width answer/)).toBeInTheDocument();
    rerender(<AgentRunLogs run={{ ...completedRun, taskId: "task-2" }} />);
    expect(screen.queryByText(/A full-width answer/)).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });
});

function emit(message: ServerWebSocketMessage) {
  act(() => socket.handlers.get(message.type)?.(message));
}

const completedRun = {
  taskId: "task-1",
  endedAt: new Date().toISOString(),
} as AgentRun;
