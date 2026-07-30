import pg from "pg";
import logger from "@/logging";

/**
 * Cross-replica wake-ups over Postgres LISTEN/NOTIFY.
 *
 * A feature that streams durable rows to a client — an A2A task's event log,
 * a chat run's replay — has to notice new rows written by *another pod*.
 * Polling alone does that but trades latency for load. `NOTIFY` is delivered
 * to every connection listening on that channel in the database, whichever
 * pod holds it, so Postgres is the broker and there is no cross-pod
 * coordination to build.
 *
 * Three properties shape the design:
 *
 *  - **Notifications are not durable.** Anything published while a listener
 *    is disconnected is simply gone. So a notify only ever wakes a poll
 *    *early* — every caller still passes a `timeoutMs` and re-reads the
 *    database. Correctness never depends on delivery.
 *  - **LISTEN needs a session-stable connection**, so this owns a dedicated
 *    client rather than borrowing from the query pool, and re-issues every
 *    LISTEN after a reconnect.
 *  - **One connection, many channels.** Each feature takes its own logical
 *    channel from the same hub, so adding one does not add a connection per
 *    pod.
 *
 * Payloads carry only a key (a task id, a run id) — never the event itself.
 * `NOTIFY` payloads are capped at 8000 bytes, and the durable row is the
 * record anyway; this just says "go look".
 */
export interface KeyedNotifier {
  /** Wake every listener waiting on `key`, on this pod and every other. */
  notify(key: string): Promise<void>;
  /** Resolve when `key` is notified, when aborted, or when the timeout fires. */
  wait(params: KeyedWaitParams): Promise<void>;
}

export interface KeyedWaitParams {
  key: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

export interface PgNotifyHub {
  channel(name: string): KeyedNotifier;
  close(): Promise<void>;
}

/**
 * Hub that never talks to Postgres: waiters are woken only by their own
 * timeout. Used when the database endpoint cannot hold a session-stable
 * listener — PgBouncer in transaction-pooling mode, or a managed proxy that
 * recycles connections — where LISTEN would silently never fire.
 */
export function createPollingNotifyHub(): PgNotifyHub {
  return {
    channel: () => ({
      async notify() {},
      async wait(params) {
        await sleepWithAbort(params.timeoutMs, params.abortSignal);
      },
    }),
    async close() {},
  };
}

export function createPostgresNotifyHub(
  connectionString: string,
  clientFactory: PgClientFactory = createDefaultPgClient,
): PgNotifyHub {
  return new PostgresNotifyHub(connectionString, clientFactory);
}

/** @public — exported for testability */
export class PostgresNotifyHub implements PgNotifyHub {
  private client: PgClient | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly waitersByChannel = new Map<string, KeyWaiters>();

  constructor(
    private readonly connectionString: string,
    private readonly clientFactory: PgClientFactory = createDefaultPgClient,
  ) {}

  channel(name: string): KeyedNotifier {
    if (!this.waitersByChannel.has(name)) {
      this.waitersByChannel.set(name, new KeyWaiters());
    }

    return {
      notify: (key) => this.publish(name, key),
      wait: async (params) => {
        // Register before connecting. `KeyWaiters.wait` enrolls the waiter
        // synchronously, so a notify published during the connect handshake
        // still wakes it instead of being dropped on the floor.
        const waiting = this.waiters(name).wait(params);

        // Connect lazily on first wait so a pod that never subscribes never
        // opens a listener connection.
        await this.ensureConnected().catch((error) => {
          logger.warn(
            { error, channel: name },
            "Failed to establish the Postgres notify listener; falling back to the poll interval",
          );
        });
        await waiting;
      },
    };
  }

  async close(): Promise<void> {
    await this.connectPromise?.catch(() => undefined);
    await this.resetClient(this.client);
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private waiters(channel: string): KeyWaiters {
    const existing = this.waitersByChannel.get(channel);
    if (existing) {
      return existing;
    }
    const created = new KeyWaiters();
    this.waitersByChannel.set(channel, created);
    return created;
  }

  private async publish(channel: string, key: string): Promise<void> {
    // Wake same-pod waiters directly: they must not depend on the round trip,
    // and this keeps local behavior identical in polling-compatibility mode.
    this.waiters(channel).notify(key);

    try {
      await this.ensureConnected();
      // pg_notify() takes the channel as a parameter, so channel names never
      // go through string interpolation into SQL.
      await this.client?.query("select pg_notify($1, $2)", [
        channel,
        JSON.stringify({ key }),
      ]);
    } catch (error) {
      await this.resetClient(this.client);
      logger.warn({ error, channel, key }, "Failed to publish a notification");
    }
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connectPromise) {
      const client = this.createClient();
      this.client = client;
      this.connectPromise = this.connectClient(client);
    }

    await this.connectPromise;
  }

  private createClient(): PgClient {
    const client = this.clientFactory(this.connectionString);

    client.on("notification", (notification) => {
      const { channel, payload } = notification as pg.Notification;
      const key = parseKey(payload);
      if (key) {
        this.waiters(channel).notify(key);
      }
    });
    client.on("error", (error) => {
      logger.warn({ error }, "Postgres notify connection error");
      void this.resetClient(client);
    });
    client.on("end", () => {
      if (this.client === client) {
        this.client = null;
        this.connectPromise = null;
      }
    });

    return client;
  }

  private async connectClient(client: PgClient): Promise<void> {
    try {
      await client.connect();
      // Re-LISTEN every registered channel: after a reconnect the old
      // subscriptions died with the session.
      for (const channel of this.waitersByChannel.keys()) {
        await client.query(`LISTEN ${quoteIdentifier(channel)}`);
      }
    } catch (error) {
      await this.resetClient(client);
      throw error;
    }
  }

  private async resetClient(client: PgClient | null): Promise<void> {
    if (!client || this.client !== client) {
      return;
    }

    this.client = null;
    this.connectPromise = null;
    await client.end().catch((error) => {
      logger.warn({ error }, "Failed to close the Postgres notify connection");
    });
  }
}

/** Local waiters for one channel, keyed by the id they are waiting on. */
class KeyWaiters {
  private readonly waiters = new Map<string, Set<() => void>>();

  notify(key: string): void {
    const waiters = this.waiters.get(key);
    if (!waiters) {
      return;
    }

    this.waiters.delete(key);
    for (const resolve of waiters) {
      resolve();
    }
  }

  async wait(params: KeyedWaitParams): Promise<void> {
    if (params.abortSignal?.aborted) {
      return;
    }

    await new Promise<void>((resolve) => {
      const cleanup = () => {
        clearTimeout(timeout);
        params.abortSignal?.removeEventListener("abort", onAbort);
        const waiters = this.waiters.get(params.key);
        waiters?.delete(resolveAndCleanup);
        if (waiters?.size === 0) {
          this.waiters.delete(params.key);
        }
      };

      const resolveAndCleanup = () => {
        cleanup();
        resolve();
      };

      const onAbort = () => resolveAndCleanup();
      const timeout = setTimeout(resolveAndCleanup, params.timeoutMs);
      params.abortSignal?.addEventListener("abort", onAbort, { once: true });

      const waiters = this.waiters.get(params.key) ?? new Set<() => void>();
      waiters.add(resolveAndCleanup);
      this.waiters.set(params.key, waiters);
    });
  }
}

/** @public — exported for testability (the injectable listener connection) */
export interface PgClient {
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
  query(queryText: string, values?: unknown[]): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

type PgClientFactory = (connectionString: string) => PgClient;

/**
 * LISTEN takes an identifier, not a parameter, so the channel name is the one
 * value that must be interpolated. Channel names are compile-time constants
 * in this codebase; quoting keeps that true even if one ever is not.
 */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function parseKey(payload: string | undefined): string | null {
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload);
    return typeof parsed.key === "string" ? parsed.key : null;
  } catch {
    return null;
  }
}

function createDefaultPgClient(connectionString: string): PgClient {
  return new pg.Client({
    connectionString,
    connectionTimeoutMillis: 1_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
}

function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (abortSignal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(resolveAndCleanup, ms);
    const onAbort = () => resolveAndCleanup();

    function resolveAndCleanup() {
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
