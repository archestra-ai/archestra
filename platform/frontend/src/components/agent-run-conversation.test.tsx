import type {
  AgentRunReadableTranscript,
  ServerWebSocketMessage,
} from "@archestra/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";

const socket = vi.hoisted(() => ({
  handlers: new Map<string, (message: ServerWebSocketMessage) => void>(),
  connection: (_connected: boolean) => {},
  isConnected: () => true,
  onConnectionChange(callback: (connected: boolean) => void) {
    this.connection = callback;
    return () => {};
  },
  send: vi.fn(),
  subscribe(type: string, callback: (message: ServerWebSocketMessage) => void) {
    this.handlers.set(type, callback);
    return () => this.handlers.delete(type);
  },
}));
vi.mock("@/lib/websocket/websocket", () => ({ default: socket }));

import { AgentRunConversation } from "./agent-run-conversation";

beforeEach(() => {
  socket.handlers.clear();
  socket.send.mockClear();
});

test("preserves an unsent message across disconnection and clears only a successful acknowledgement", async () => {
  render(<AgentRunConversation transcript={idle} taskId="run-1" canControl />);
  const input = screen.getByRole("textbox", { name: "Message the agent" });
  await userEvent.type(input, "Read the file");
  act(() => socket.connection(false));
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(input).toHaveValue("Read the file");
  act(() => socket.connection(true));
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(input).toHaveValue("Read the file");
  acknowledge("Agent busy");
  expect(screen.getByRole("alert")).toHaveTextContent("Agent busy");
  expect(input).toHaveValue("Read the file");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  acknowledge();
  expect(input).toHaveValue("");
});

test("interrupts without discarding a drafted follow-up and hides controls for observers", async () => {
  const transcript = {
    ...idle,
    session: { state: "working" as const, requests: [] },
  };
  const { rerender } = render(
    <AgentRunConversation transcript={transcript} taskId="run-1" canControl />,
  );
  await userEvent.type(screen.getByRole("textbox"), "Next instruction");
  await userEvent.click(screen.getByRole("button", { name: "Interrupt" }));
  expect(socket.send.mock.lastCall?.[0].payload.control).toEqual({
    type: "interrupt",
  });
  acknowledge();
  expect(screen.getByRole("textbox")).toHaveValue("Next instruction");
  rerender(
    <AgentRunConversation
      transcript={idle}
      taskId="run-1"
      canControl={false}
    />,
  );
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

test("keeps the reading position as output arrives until Latest messages is requested", async () => {
  const { rerender } = render(
    <AgentRunConversation
      transcript={idle}
      taskId="run-1"
      canControl={false}
    />,
  );
  const viewport = screen.getByRole("region", { name: "Agent conversation" });
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 1200 },
    clientHeight: { value: 300 },
  });
  viewport.scrollTop = 200;
  fireEvent.scroll(viewport);
  rerender(
    <AgentRunConversation
      transcript={{
        ...idle,
        entries: [{ type: "message", role: "assistant", text: "New output" }],
      }}
      taskId="run-1"
      canControl={false}
    />,
  );
  expect(viewport.scrollTop).toBe(200);
  await userEvent.click(
    screen.getByRole("button", { name: "Latest messages" }),
  );
  expect(viewport.scrollTop).toBe(1200);
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
