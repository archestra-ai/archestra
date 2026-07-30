import { describe, expect, test, vi } from "vitest";
import {
  createPollingNotifyHub,
  type PgClient,
  PostgresNotifyHub,
} from "./pg-notify-hub";

/**
 * A stand-in for the dedicated listener connection. Postgres is the process
 * boundary here; everything above it — channel multiplexing, waiter wake-up,
 * re-LISTEN on reconnect — is exercised for real.
 */
class FakePgClient implements PgClient {
  readonly queries: string[] = [];
  readonly notifies: { channel: string; payload: string }[] = [];
  private handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  connected = false;
  ended = false;

  async connect() {
    this.connected = true;
  }

  async end() {
    this.ended = true;
    this.emit("end");
  }

  async query(text: string, values?: unknown[]) {
    this.queries.push(text);
    if (values) {
      this.notifies.push({
        channel: String(values[0]),
        payload: String(values[1]),
      });
    }
    return undefined;
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    const listeners = this.handlers.get(event) ?? [];
    listeners.push(listener);
    this.handlers.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.handlers.get(event) ?? []) {
      listener(...args);
    }
  }

  /** Simulate a notification arriving from another replica. */
  deliver(channel: string, key: string) {
    this.emit("notification", { channel, payload: JSON.stringify({ key }) });
  }

  get listenedChannels(): string[] {
    return this.queries
      .filter((q) => q.startsWith("LISTEN"))
      .map((q) => q.replace(/^LISTEN "?|"?$/g, ""));
  }
}

function hubWithFakeClient() {
  const client = new FakePgClient();
  const hub = new PostgresNotifyHub("postgres://test", () => client);
  return { hub, client };
}

describe("PostgresNotifyHub", () => {
  test("a notification from another replica wakes the waiter early", async () => {
    const { hub, client } = hubWithFakeClient();
    const channel = hub.channel("a2a_task_events");

    // A long timeout: if the wake does not work, this test times out rather
    // than passing on the fallback poll.
    const waiting = channel.wait({ key: "task-1", timeoutMs: 60_000 });
    await vi.waitFor(() => expect(client.connected).toBe(true));

    client.deliver("a2a_task_events", "task-1");

    await expect(waiting).resolves.toBeUndefined();
  });

  test("only the waiter for that key is woken", async () => {
    const { hub, client } = hubWithFakeClient();
    const channel = hub.channel("a2a_task_events");

    let otherResolved = false;
    const other = channel.wait({ key: "task-2", timeoutMs: 200 }).then(() => {
      otherResolved = true;
    });
    const target = channel.wait({ key: "task-1", timeoutMs: 60_000 });
    await vi.waitFor(() => expect(client.connected).toBe(true));

    client.deliver("a2a_task_events", "task-1");
    await target;
    // task-2's waiter is still pending on its own timeout, not woken by task-1.
    expect(otherResolved).toBe(false);
    await other;
  });

  test("channels are isolated from each other on the shared connection", async () => {
    const { hub, client } = hubWithFakeClient();
    const a2a = hub.channel("a2a_task_events");
    const chat = hub.channel("chat_active_run_events");

    let chatResolved = false;
    const chatWait = chat.wait({ key: "same-id", timeoutMs: 200 }).then(() => {
      chatResolved = true;
    });
    const a2aWait = a2a.wait({ key: "same-id", timeoutMs: 60_000 });
    await vi.waitFor(() => expect(client.connected).toBe(true));

    client.deliver("a2a_task_events", "same-id");
    await a2aWait;
    expect(chatResolved).toBe(false);
    await chatWait;
  });

  test("every registered channel is listened on one connection", async () => {
    const { hub, client } = hubWithFakeClient();
    hub.channel("a2a_task_events");
    hub.channel("chat_active_run_events");

    await hub.channel("a2a_task_events").wait({ key: "k", timeoutMs: 1 });

    expect(client.listenedChannels.sort()).toEqual([
      "a2a_task_events",
      "chat_active_run_events",
    ]);
  });

  test("publishing wakes a same-pod waiter without depending on the round trip", async () => {
    const { hub } = hubWithFakeClient();
    const channel = hub.channel("a2a_task_events");

    const waiting = channel.wait({ key: "task-1", timeoutMs: 60_000 });
    await channel.notify("task-1");

    await expect(waiting).resolves.toBeUndefined();
  });

  test("publishing sends the key, never the payload, over pg_notify", async () => {
    const { hub, client } = hubWithFakeClient();
    await hub.channel("a2a_task_events").notify("task-1");

    expect(client.notifies).toEqual([
      {
        channel: "a2a_task_events",
        payload: JSON.stringify({ key: "task-1" }),
      },
    ]);
  });

  test("a waiter still resolves on its timeout when nothing is notified", async () => {
    const { hub } = hubWithFakeClient();
    // This is the property the whole design leans on: notifications are not
    // durable, so a missed one only ever costs latency.
    await expect(
      hub.channel("a2a_task_events").wait({ key: "task-1", timeoutMs: 10 }),
    ).resolves.toBeUndefined();
  });

  test("an aborted wait returns immediately", async () => {
    const { hub } = hubWithFakeClient();
    const controller = new AbortController();
    controller.abort();

    await expect(
      hub.channel("a2a_task_events").wait({
        key: "task-1",
        timeoutMs: 60_000,
        abortSignal: controller.signal,
      }),
    ).resolves.toBeUndefined();
  });

  test("re-LISTENs every channel after the connection drops", async () => {
    const clients: FakePgClient[] = [];
    const hub = new PostgresNotifyHub("postgres://test", () => {
      const client = new FakePgClient();
      clients.push(client);
      return client;
    });
    hub.channel("a2a_task_events");
    hub.channel("chat_active_run_events");

    await hub.channel("a2a_task_events").wait({ key: "k", timeoutMs: 1 });
    expect(clients).toHaveLength(1);

    // The listener dies; the subscriptions died with the session.
    clients[0].emit("error", new Error("connection reset"));
    await vi.waitFor(() => expect(clients[0].ended).toBe(true));

    await hub.channel("a2a_task_events").wait({ key: "k", timeoutMs: 1 });

    expect(clients).toHaveLength(2);
    expect(clients[1].listenedChannels.sort()).toEqual([
      "a2a_task_events",
      "chat_active_run_events",
    ]);
  });

  test("a failed connection degrades to the timeout instead of throwing", async () => {
    const hub = new PostgresNotifyHub("postgres://test", () => {
      const client = new FakePgClient();
      client.connect = async () => {
        throw new Error("no route to host");
      };
      return client;
    });

    await expect(
      hub.channel("a2a_task_events").wait({ key: "task-1", timeoutMs: 10 }),
    ).resolves.toBeUndefined();
  });
});

describe("polling notify hub", () => {
  test("never connects and resolves purely on the timeout", async () => {
    // Used behind a transaction pooler, where LISTEN would silently never fire.
    const hub = createPollingNotifyHub();
    const channel = hub.channel("a2a_task_events");

    await channel.notify("task-1");
    await expect(
      channel.wait({ key: "task-1", timeoutMs: 10 }),
    ).resolves.toBeUndefined();
  });
});
