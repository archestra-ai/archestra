import { EventEmitter } from "node:events";
import type { Exec } from "@kubernetes/client-node";
import { afterEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { execAgentRuntimeCommand, streamAgentRuntimeCommand } from "./exec";

afterEach(() => vi.useRealTimers());

test("returns the full successful output, without leaking stderr", async () => {
  const boundary = connection();
  boundary.exec.mockImplementation(async (...args) => {
    args[4]?.write("first");
    args[5]?.write("private diagnostic");
    args[4]?.write("second");
    args[8]?.({ status: "Success" });
    return boundary.socket;
  });
  await expect(run(boundary)).resolves.toBe("firstsecond");
  expect(boundary.terminate).toHaveBeenCalledOnce();
});

test.each([
  "stdout",
  "stderr",
])("bounds %s even before connection resolves", async (stream) => {
  const boundary = connection();
  boundary.exec.mockImplementation(async (...args) => {
    args[stream === "stdout" ? 4 : 5]?.write("12345");
    return boundary.socket;
  });
  await expect(run(boundary, { maxOutputBytes: 4 })).rejects.toThrow(
    "output limit",
  );
  expect(boundary.terminate).toHaveBeenCalledOnce();
});

test("times out an exec handshake and closes a late connection", async () => {
  vi.useFakeTimers();
  const boundary = connection();
  let connect!: (socket: WebSocket) => void;
  boundary.exec.mockImplementation(
    () =>
      new Promise((resolve) => {
        connect = resolve;
      }),
  );
  const result = expect(run(boundary, { timeoutMs: 100 })).rejects.toThrow(
    "timed out",
  );
  await vi.advanceTimersByTimeAsync(100);
  await result;
  connect(boundary.socket);
  await Promise.resolve();
  expect(boundary.terminate).toHaveBeenCalledOnce();
});

test("rejects a disconnected command rather than reporting partial output as success", async () => {
  const boundary = connection();
  const result = expect(run(boundary)).rejects.toThrow("disconnected");
  await Promise.resolve();
  boundary.socket.emit("close");
  await result;
});

test("does not expose runtime diagnostics in failed command errors", async () => {
  const boundary = connection();
  boundary.exec.mockImplementation(async (...args) => {
    args[5]?.write("private file contents");
    args[8]?.({ status: "Failure", message: "private status contents" });
    return boundary.socket;
  });
  await expect(run(boundary)).rejects.toThrow(
    /^Command in Agent Runtime pod failed$/,
  );
});

test("streams output before the command completes, without leaking stderr", async () => {
  const boundary = connection();
  let complete!: () => void;
  boundary.exec.mockImplementation(async (...args) => {
    args[4]?.write("early bytes");
    args[5]?.write("private diagnostic");
    complete = () => args[8]?.({ status: "Success" });
    return boundary.socket;
  });
  const { stdout, completed } = runStream(boundary);
  let finished = false;
  void completed.then(() => {
    finished = true;
  });
  const chunk = await new Promise<Buffer>((resolve) =>
    stdout.once("data", resolve),
  );
  // A buffering implementation could not hand over bytes this early.
  expect(chunk.toString()).toBe("early bytes");
  expect(finished).toBe(false);
  complete();
  await expect(completed).resolves.toBeUndefined();
});

test("reports a failed streaming command without runtime diagnostics", async () => {
  const boundary = connection();
  boundary.exec.mockImplementation(async (...args) => {
    args[5]?.write("private file contents");
    args[8]?.({ status: "Failure", message: "private status contents" });
    return boundary.socket;
  });
  const { stdout, completed } = runStream(boundary);
  stdout.on("error", () => {});
  await expect(completed).rejects.toThrow(
    /^Command in Agent Runtime pod failed$/,
  );
});

test("terminates the connection when the consumer stops reading", async () => {
  const boundary = connection();
  const { stdout, completed } = runStream(boundary);
  await Promise.resolve();
  // A client that disconnects mid-download must not leave the session running.
  stdout.destroy();
  await expect(completed).rejects.toThrow("disconnected");
  expect(boundary.terminate).toHaveBeenCalledOnce();
});

test("bounds a streaming transfer that never finishes", async () => {
  vi.useFakeTimers();
  const boundary = connection();
  boundary.exec.mockImplementation(() => new Promise(() => {}));
  const { stdout, completed } = runStream(boundary, { timeoutMs: 100 });
  stdout.on("error", () => {});
  const result = expect(completed).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(100);
  await result;
});

function connection() {
  const terminate = vi.fn();
  const socket = Object.assign(new EventEmitter(), {
    terminate,
  }) as unknown as WebSocket;
  return {
    socket,
    terminate,
    exec: vi.fn<Exec["exec"]>().mockResolvedValue(socket),
  };
}

function run(
  boundary: ReturnType<typeof connection>,
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
) {
  return execAgentRuntimeCommand({
    exec: boundary,
    namespace: "test",
    podName: "workspace",
    container: "agent-runtime",
    command: ["true"],
    ...options,
  });
}

function runStream(
  boundary: ReturnType<typeof connection>,
  options: { timeoutMs?: number } = {},
) {
  return streamAgentRuntimeCommand({
    exec: boundary,
    namespace: "test",
    podName: "workspace",
    container: "agent-runtime",
    command: ["true"],
    timeoutMs: 30_000,
    ...options,
  });
}
