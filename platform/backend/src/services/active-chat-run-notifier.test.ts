import { vi } from "vitest";
import { afterEach, beforeEach, expect, test } from "@/test";

const originalEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
  process.env.ARCHESTRA_DATABASE_URL =
    "postgresql://user:pass@localhost:5432/db";
});

afterEach(() => {
  process.env = originalEnv;
});

test("PostgresActiveChatRunNotifier listens before publishing notifications", async () => {
  const { PostgresActiveChatRunNotifier } = await import(
    "./active-chat-run-notifier"
  );
  const clients: MockPgClient[] = [];
  const notifier = new PostgresActiveChatRunNotifier(
    "postgresql://user:pass@localhost:5432/db",
    createMockPgClientFactory(clients),
  );

  await notifier.notifyEvent("run-1");
  await notifier.notifyStop("run-1");

  const client = clients[0];
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

test("PostgresActiveChatRunNotifier listens before waiting for event notifications", async () => {
  const { PostgresActiveChatRunNotifier } = await import(
    "./active-chat-run-notifier"
  );
  const clients: MockPgClient[] = [];
  const notifier = new PostgresActiveChatRunNotifier(
    "postgresql://user:pass@localhost:5432/db",
    createMockPgClientFactory(clients),
  );

  const waitPromise = notifier.waitForEvent({
    runId: "run-1",
    timeoutMs: 10_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  clients[0]?.handlers.notification?.({
    channel: "chat_active_run_events",
    payload: JSON.stringify({ runId: "run-1" }),
  });
  await waitPromise;

  const client = clients[0];
  expect(client?.connect).toHaveBeenCalledTimes(1);
  expect(client?.query).toHaveBeenNthCalledWith(
    1,
    "LISTEN chat_active_run_events",
  );
  expect(client?.query).toHaveBeenNthCalledWith(
    2,
    "LISTEN chat_active_run_stops",
  );
});

test("PostgresActiveChatRunNotifier listens before waiting for stop notifications", async () => {
  const { PostgresActiveChatRunNotifier } = await import(
    "./active-chat-run-notifier"
  );
  const clients: MockPgClient[] = [];
  const notifier = new PostgresActiveChatRunNotifier(
    "postgresql://user:pass@localhost:5432/db",
    createMockPgClientFactory(clients),
  );

  const waitPromise = notifier.waitForStop({
    runId: "run-1",
    timeoutMs: 10_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  clients[0]?.handlers.notification?.({
    channel: "chat_active_run_stops",
    payload: JSON.stringify({ runId: "run-1" }),
  });
  await waitPromise;

  const client = clients[0];
  expect(client?.connect).toHaveBeenCalledTimes(1);
  expect(client?.query).toHaveBeenNthCalledWith(
    1,
    "LISTEN chat_active_run_events",
  );
  expect(client?.query).toHaveBeenNthCalledWith(
    2,
    "LISTEN chat_active_run_stops",
  );
});

test("PostgresActiveChatRunNotifier reconnects after initial listen failure", async () => {
  const { PostgresActiveChatRunNotifier } = await import(
    "./active-chat-run-notifier"
  );
  const clients: MockPgClient[] = [];
  const notifier = new PostgresActiveChatRunNotifier(
    "postgresql://user:pass@localhost:5432/db",
    createMockPgClientFactory(clients, [
      {
        query: vi
          .fn(async (_queryText: string, _values?: unknown[]) => ({
            rows: [],
          }))
          .mockRejectedValueOnce(new Error("listen failed"))
          .mockResolvedValue({ rows: [] }),
      },
    ]),
  );

  await notifier.notifyEvent("run-1");
  await notifier.notifyEvent("run-2");

  expect(clients).toHaveLength(2);
  expect(clients[0]?.end).toHaveBeenCalledTimes(1);
  expect(clients[1]?.connect).toHaveBeenCalledTimes(1);
  expect(clients[1]?.query).toHaveBeenLastCalledWith(
    "select pg_notify($1, $2)",
    ["chat_active_run_events", JSON.stringify({ runId: "run-2" })],
  );
});

test("PostgresActiveChatRunNotifier reconnects after client error", async () => {
  const { PostgresActiveChatRunNotifier } = await import(
    "./active-chat-run-notifier"
  );
  const clients: MockPgClient[] = [];
  const notifier = new PostgresActiveChatRunNotifier(
    "postgresql://user:pass@localhost:5432/db",
    createMockPgClientFactory(clients),
  );

  await notifier.notifyEvent("run-1");
  clients[0]?.handlers.error?.(new Error("connection lost"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await notifier.notifyStop("run-2");

  expect(clients).toHaveLength(2);
  expect(clients[0]?.end).toHaveBeenCalledTimes(1);
  expect(clients[1]?.connect).toHaveBeenCalledTimes(1);
  expect(clients[1]?.query).toHaveBeenLastCalledWith(
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

function createMockPgClientFactory(
  clients: MockPgClient[],
  overrides: Array<Partial<MockPgClient>> = [],
) {
  return () => {
    const client = createMockPgClient(overrides[clients.length]);
    clients.push(client);
    return client;
  };
}

function createMockPgClient(overrides?: Partial<MockPgClient>): MockPgClient {
  const handlers: MockPgClient["handlers"] = {};
  return {
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    handlers,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
      return undefined;
    }),
    query: vi.fn(async (_queryText: string, _values?: unknown[]) => ({
      rows: [],
    })),
    ...overrides,
  };
}

interface MockPgClient {
  connect: () => Promise<unknown>;
  end: () => Promise<unknown>;
  handlers: Record<string, (...args: unknown[]) => void>;
  on: (event: string, handler: (...args: unknown[]) => void) => unknown;
  query: (queryText: string, values?: unknown[]) => Promise<unknown>;
}
