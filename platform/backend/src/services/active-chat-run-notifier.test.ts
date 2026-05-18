import { vi } from "vitest";
import { afterEach, beforeEach, expect, test } from "@/test";

const pgMocks = vi.hoisted(() => ({
  Client: vi.fn(),
  clients: [] as Array<{
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    handlers: Record<string, (...args: unknown[]) => void>;
    on: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("pg", () => ({
  default: {
    Client: pgMocks.Client,
  },
}));

const originalEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
  process.env.ARCHESTRA_DATABASE_URL =
    "postgresql://user:pass@localhost:5432/db";
  pgMocks.clients.length = 0;
  pgMocks.Client.mockReset().mockImplementation(function Client() {
    return createMockPgClient();
  });
});

afterEach(() => {
  process.env = originalEnv;
});

test("PostgresActiveChatRunNotifier listens before publishing notifications", async () => {
  const { PostgresActiveChatRunNotifier } = await import(
    "./active-chat-run-notifier"
  );
  const notifier = new PostgresActiveChatRunNotifier(
    "postgresql://user:pass@localhost:5432/db",
  );

  await notifier.notifyEvent("run-1");
  await notifier.notifyStop("run-1");

  const client = pgMocks.clients[0];
  expect(client?.connect).toHaveBeenCalledTimes(1);
  expect(client?.query).toHaveBeenNthCalledWith(
    1,
    "LISTEN chat_active_run_events",
  );
  expect(client?.query).toHaveBeenNthCalledWith(
    2,
    "LISTEN chat_active_run_stops",
  );
  expect(client?.query).toHaveBeenNthCalledWith(3, "select pg_notify($1, $2)", [
    "chat_active_run_events",
    JSON.stringify({ runId: "run-1" }),
  ]);
  expect(client?.query).toHaveBeenNthCalledWith(4, "select pg_notify($1, $2)", [
    "chat_active_run_stops",
    JSON.stringify({ runId: "run-1" }),
  ]);
});

test("PostgresActiveChatRunNotifier reconnects after initial listen failure", async () => {
  const { PostgresActiveChatRunNotifier } = await import(
    "./active-chat-run-notifier"
  );
  const notifier = new PostgresActiveChatRunNotifier(
    "postgresql://user:pass@localhost:5432/db",
  );

  pgMocks.Client.mockImplementationOnce(function Client() {
    return createMockPgClient({
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error("listen failed"))
        .mockResolvedValue({ rows: [] }),
    });
  });

  await notifier.notifyEvent("run-1");
  await notifier.notifyEvent("run-2");

  expect(pgMocks.clients).toHaveLength(2);
  expect(pgMocks.clients[0]?.end).toHaveBeenCalledTimes(1);
  expect(pgMocks.clients[1]?.connect).toHaveBeenCalledTimes(1);
  expect(pgMocks.clients[1]?.query).toHaveBeenLastCalledWith(
    "select pg_notify($1, $2)",
    ["chat_active_run_events", JSON.stringify({ runId: "run-2" })],
  );
});

test("PostgresActiveChatRunNotifier reconnects after client error", async () => {
  const { PostgresActiveChatRunNotifier } = await import(
    "./active-chat-run-notifier"
  );
  const notifier = new PostgresActiveChatRunNotifier(
    "postgresql://user:pass@localhost:5432/db",
  );

  await notifier.notifyEvent("run-1");
  pgMocks.clients[0]?.handlers.error?.(new Error("connection lost"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await notifier.notifyStop("run-2");

  expect(pgMocks.clients).toHaveLength(2);
  expect(pgMocks.clients[0]?.end).toHaveBeenCalledTimes(1);
  expect(pgMocks.clients[1]?.connect).toHaveBeenCalledTimes(1);
  expect(pgMocks.clients[1]?.query).toHaveBeenLastCalledWith(
    "select pg_notify($1, $2)",
    ["chat_active_run_stops", JSON.stringify({ runId: "run-2" })],
  );
});

test("createActiveChatRunNotifier uses Postgres notifier by default", async () => {
  delete process.env.ARCHESTRA_CHAT_ACTIVE_RUN_POLLING_COMPATIBILITY_ENABLED;

  const { createActiveChatRunNotifier, PostgresActiveChatRunNotifier } =
    await import("./active-chat-run-notifier");

  const notifier = createActiveChatRunNotifier();

  expect(notifier).toBeInstanceOf(PostgresActiveChatRunNotifier);
  await notifier.close?.();
});

test("createActiveChatRunNotifier uses polling notifier in compatibility mode", async () => {
  process.env.ARCHESTRA_CHAT_ACTIVE_RUN_POLLING_COMPATIBILITY_ENABLED = "true";

  const { createActiveChatRunNotifier, PollingActiveChatRunNotifier } =
    await import("./active-chat-run-notifier");

  expect(createActiveChatRunNotifier()).toBeInstanceOf(
    PollingActiveChatRunNotifier,
  );
});

function createMockPgClient(overrides?: { query?: ReturnType<typeof vi.fn> }) {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
    handlers,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
    }),
    query: overrides?.query ?? vi.fn().mockResolvedValue({ rows: [] }),
  };
  pgMocks.clients.push(client);
  return client;
}
