import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { requestScope } from "@/auth/request-scope";
import {
  ConfigCache,
  PROXY_CONFIG_CHANNEL,
  PROXY_CONFIG_TTL_MS,
} from "@/services/config-cache";
import { type PgClient, PostgresNotifyHub } from "@/services/pg-notify-hub";

/**
 * The listener connection is the process boundary. The hub above it, and its
 * delivery verification, run for real.
 */
class FakePgClient implements PgClient {
  /** When false, LISTEN succeeds but nothing is delivered (a pooler). */
  deliversNotifications = true;
  private handlers = new Map<string, ((...args: unknown[]) => void)[]>();

  async connect() {}

  async end() {
    this.emit("end");
  }

  async query(_text: string, values?: unknown[]) {
    if (values && this.deliversNotifications) {
      const [channel, payload] = values.map(String);
      queueMicrotask(() => this.emit("notification", { channel, payload }));
    }
    return undefined;
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.handlers.get(event) ?? []) listener(...args);
  }

  /** What the database's trigger sends when a proxy configuration row changes. */
  rowChanged(table: string) {
    this.emit("notification", {
      channel: PROXY_CONFIG_CHANNEL,
      payload: JSON.stringify({ origin: "database", message: table }),
    });
  }
}

describe("ConfigCache", () => {
  let clients: FakePgClient[];
  let cache: ConfigCache;
  let loads: number;
  const load = async () => ++loads;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clients = [];
    loads = 0;
    const hub = new PostgresNotifyHub("postgres://test", () => {
      const client = new FakePgClient();
      clients.push(client);
      return client;
    });
    cache = new ConfigCache(hub);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Subscribe, let delivery verify, then pass the LISTEN settle window. */
  async function becomeLive() {
    await cache.read("warmup", load);
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.setSystemTime(Date.now() + 2_001);
    loads = 0;
  }

  test("serves repeat reads from memory once notifications arrive", async () => {
    await becomeLive();

    expect(await cache.read("gateway", load)).toBe(1);
    expect(await cache.read("gateway", load)).toBe(1);
    expect(loads).toBe(1);
  });

  /** Run `body` as one request with the given scope. */
  function inRequest<T>(
    scope: { memoize: boolean; sharesConfig?: boolean },
    body: () => Promise<T>,
  ): Promise<T> {
    return (async () => {
      requestScope.enter(scope);
      return body();
    })();
  }

  test("requests that opt in share a copy of configuration other requests read", async () => {
    await becomeLive();
    const loadRow = async () => ({ loads: ++loads, tools: ["lookup"] });
    const shared = { memoize: true, sharesConfig: true };

    const first = await inRequest(shared, async () => {
      const row = await cache.readShared("tools", loadRow);
      row.tools.push("changed by the caller");
      return row;
    });
    const second = await inRequest(shared, () =>
      cache.readShared("tools", loadRow),
    );

    expect(first.loads).toBe(1);
    expect(second).toEqual({ loads: 1, tools: ["lookup"] });
  });

  test("other requests read once per request, never from other requests", async () => {
    await becomeLive();
    const reads = await Promise.all(
      [{ memoize: true }, { memoize: true }, { memoize: false }].map((scope) =>
        inRequest(scope, async () => [
          await cache.readShared("tools", load),
          await cache.readShared("tools", load),
        ]),
      ),
    );

    // Each memoizing request reads once; a write request reads every time.
    expect(reads.flat()).toHaveLength(6);
    expect(new Set(reads.flat()).size).toBe(4);
    expect(reads[0][0]).toBe(reads[0][1]);
    expect(reads[2][0]).not.toBe(reads[2][1]);
  });

  test("reads the database every time while delivery is unproven", async () => {
    const hub = new PostgresNotifyHub("postgres://test", () => {
      const client = new FakePgClient();
      client.deliversNotifications = false;
      return client;
    });
    cache = new ConfigCache(hub);
    await cache.read("warmup", load);
    vi.setSystemTime(Date.now() + 2_001);

    await cache.read("gateway", load);
    await cache.read("gateway", load);
    expect(loads).toBe(3);
  });

  test("a row change in the database drops every entry", async () => {
    await becomeLive();
    await cache.read("gateway", load);
    await cache.read("credential", load);

    clients[0].rowChanged("virtual_api_keys");

    await cache.read("gateway", load);
    await cache.read("credential", load);
    expect(loads).toBe(4);
  });

  test("entries from an earlier listener session are not trusted", async () => {
    await becomeLive();
    await cache.read("gateway", load);

    // Changes published while the listener reconnects are lost.
    clients[0].emit("error", new Error("connection reset"));
    await cache.read("gateway", load);
    expect(loads).toBe(2);

    await vi.waitFor(() => expect(clients.length).toBeGreaterThan(1), {
      timeout: 10_000,
    });
  });

  test("a read that overlaps a change is not kept", async () => {
    await becomeLive();
    await cache.read("gateway", async () => {
      clients[0].rowChanged("agents");
      return load();
    });

    await cache.read("gateway", load);
    expect(loads).toBe(2);
  });

  test("an entry expires without a notification", async () => {
    await becomeLive();
    await cache.read("gateway", load);

    vi.setSystemTime(Date.now() + PROXY_CONFIG_TTL_MS + 1);

    await cache.read("gateway", load);
    expect(loads).toBe(2);
  });

  test("concurrent misses share one database read", async () => {
    await becomeLive();
    let release = () => {};
    const slow = () =>
      new Promise<number>((resolve) => {
        release = () => resolve(++loads);
      });

    const reads = Array.from({ length: 20 }, () => cache.read("gateway", slow));
    release();

    expect(await Promise.all(reads)).toEqual(Array(20).fill(1));
    expect(loads).toBe(1);
  });

  test("an aging entry is refreshed in the background, not on a miss", async () => {
    await becomeLive();
    await cache.read("gateway", load);
    vi.setSystemTime(Date.now() + PROXY_CONFIG_TTL_MS - 500);

    // Still served from memory while the refresh runs.
    expect(await cache.read("gateway", load)).toBe(1);
    await vi.waitFor(() => expect(loads).toBe(2));

    vi.setSystemTime(Date.now() + 1_000);
    expect(await cache.read("gateway", load)).toBe(2);
    expect(loads).toBe(2);
  });

  test("a failed read is not cached", async () => {
    await becomeLive();
    await expect(
      cache.read("gateway", async () => {
        throw new Error("not found");
      }),
    ).rejects.toThrow("not found");

    await cache.read("gateway", load);
    expect(loads).toBe(1);
  });
});
