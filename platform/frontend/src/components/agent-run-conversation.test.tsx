import type {
  AgentRunReadableTranscript,
  ServerWebSocketMessage,
} from "@archestra/shared";
import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  screen,
  render as testingRender,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
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

const socket = vi.hoisted(() => ({
  handlers: new Map<string, (message: ServerWebSocketMessage) => void>(),
  connection: (_connected: boolean) => {},
  isConnected: () => true,
  onConnectionChange(callback: (connected: boolean) => void) {
    this.connection = callback;
    return () => {};
  },
  send: vi.fn(),
  connect: vi.fn(),
  subscribe(type: string, callback: (message: ServerWebSocketMessage) => void) {
    this.handlers.set(type, callback);
    return () => this.handlers.delete(type);
  },
}));
vi.mock("@/lib/websocket/websocket", () => ({ default: socket }));

import { AgentRunConversation } from "./agent-run-conversation";

beforeEach(() => {
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useSession).mockReturnValue({ data: null } as ReturnType<
    typeof useSession
  >);
  vi.mocked(useOrganization).mockReturnValue({ data: undefined } as ReturnType<
    typeof useOrganization
  >);
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
  vi.mocked(usePublicConfig).mockReturnValue({ data: undefined } as ReturnType<
    typeof usePublicConfig
  >);
  localStorage.clear();
  socket.handlers.clear();
  socket.send.mockClear();
});

test("preserves an unsent message across disconnection and clears only a successful acknowledgement", async () => {
  render(
    <AgentRunConversation
      agentId="test-agent"
      agentName="Test agent"
      transcript={idle}
      taskId="run-1"
      canControl
    />,
  );
  const input = screen.getByRole("textbox");
  await userEvent.type(input, "Read the file");
  act(() => socket.connection(false));
  expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
  expect(input).toHaveValue("Read the file");
  act(() => socket.connection(true));
  await userEvent.click(screen.getByRole("button", { name: "Submit" }));
  expect(input).toHaveValue("Read the file");
  acknowledge("Agent busy");
  expect(screen.getByRole("alert")).toHaveTextContent("Agent busy");
  expect(input).toHaveValue("Read the file");
  await userEvent.click(screen.getByRole("button", { name: "Submit" }));
  acknowledge();
  await waitFor(() => expect(input).toHaveValue(""));
});

test("interrupts without discarding a drafted follow-up and hides controls for observers", async () => {
  const transcript = {
    ...idle,
    session: { state: "working" as const, requests: [] },
  };
  const { rerender } = render(
    <AgentRunConversation
      agentId="test-agent"
      agentName="Test agent"
      transcript={transcript}
      taskId="run-1"
      canControl
    />,
  );
  await userEvent.type(screen.getByRole("textbox"), "Next instruction");
  await userEvent.click(screen.getByRole("button", { name: "Stop response" }));
  expect(socket.send.mock.lastCall?.[0].payload.control).toEqual({
    type: "interrupt",
  });
  acknowledge();
  expect(screen.getByRole("textbox")).toHaveValue("Next instruction");
  rerender(
    <AgentRunConversation
      agentId="test-agent"
      agentName="Test agent"
      transcript={idle}
      taskId="run-1"
      canControl={false}
    />,
  );
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

test("renders runtime tools and messages without offering unsupported history edits", () => {
  render(
    <AgentRunConversation
      agentId="test-agent"
      agentName="Test agent"
      transcript={{
        ...idle,
        entries: [
          { type: "message", role: "user", text: "Read the file" },
          {
            type: "tool_call",
            name: "read_file",
            toolCallId: "read-1",
            input: '{"path":"test.txt"}',
          },
          { type: "tool_result", toolCallId: "read-1", text: "ORCHID" },
          {
            type: "message",
            role: "assistant",
            text: "The file contains ORCHID.",
          },
        ],
      }}
      taskId="run-1"
      canControl={false}
    />,
  );
  expect(screen.getByText("The file contains ORCHID.")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Edit" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Regenerate" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

function acknowledge(error?: string) {
  const call = socket.send.mock.lastCall;
  if (!call) throw new Error("No submitted command");
  const { runId, commandId } = call[0].payload;
  act(() =>
    socket.handlers.get("agent_run_control_result")?.({
      type: "agent_run_control_result",
      payload: { runId, commandId, error },
    }),
  );
}
const idle: AgentRunReadableTranscript = {
  version: 1,
  provider: "codex",
  entries: [],
  session: { state: "idle", requests: [] },
};
