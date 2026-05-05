import { vi } from "vitest";
import { afterEach, beforeEach, expect, test } from "@/test";

const pgMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
  query: vi.fn(),
}));

vi.mock("pg", () => ({
  default: {
    Client: vi.fn(function Client() {
      return pgMocks;
    }),
  },
}));

const originalEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
  process.env.ARCHESTRA_DATABASE_URL =
    "postgresql://user:pass@localhost:5432/db";
  pgMocks.connect.mockReset().mockResolvedValue(undefined);
  pgMocks.end.mockReset().mockResolvedValue(undefined);
  pgMocks.on.mockReset();
  pgMocks.query.mockReset().mockResolvedValue({ rows: [] });
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

  expect(pgMocks.connect).toHaveBeenCalledTimes(1);
  expect(pgMocks.query).toHaveBeenNthCalledWith(
    1,
    "LISTEN chat_active_run_events",
  );
  expect(pgMocks.query).toHaveBeenNthCalledWith(
    2,
    "LISTEN chat_active_run_stops",
  );
  expect(pgMocks.query).toHaveBeenNthCalledWith(3, "select pg_notify($1, $2)", [
    "chat_active_run_events",
    JSON.stringify({ runId: "run-1" }),
  ]);
  expect(pgMocks.query).toHaveBeenNthCalledWith(4, "select pg_notify($1, $2)", [
    "chat_active_run_stops",
    JSON.stringify({ runId: "run-1" }),
  ]);
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
