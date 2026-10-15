import { randomUUID } from "node:crypto";
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
 * Keyed channels carry only a key (a task id, a run id) — never the event
 * itself. `NOTIFY` payloads are capped at 8000 bytes, and the durable row is
 * the record anyway; this just says "go look".
 *
 * Fan-out channels are the one exception: they relay a small, self-contained
 * message (a UI status event) that every pod hands to its own subscribers,
 * for events that have no row a subscriber could re-read. They are just as
 * best-effort — a lost message only means a client learns later, from its own
 * refetch.
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

/**
 * Delivers each published message once to every subscriber, on this pod and
 * every other. Same-pod subscribers run synchronously inside `publish`, before
 * it awaits anything, so local delivery never depends on the database.
 */
export interface FanoutChannel {
  publish(message: string): Promise<void>;
  /** Returns the unsubscribe function. */
  subscribe(handler: (message: string) => void): () => void;
}

export interface PgNotifyHub {
  channel(name: string): KeyedNotifier;
  fanout(name: string): FanoutChannel;
  close(): Promise<void>;
}

/**
 * Ceiling applied to a caller's fallback timeout while notification delivery
 * is unproven.
 *
 * Callers pass the timeout they want when notifications work — seconds, since
 * a notify normally carries the latency. When nothing is being delivered that
 * same number becomes the *only* wake-up, and a 30-second Stop button is not
 * acceptable. Rather than making every feature carry two intervals and an
 * operator switch to choose between them, the hub tightens its own fallback
 * for exactly as long as it cannot prove delivery works.
 */
const UNVERIFIED_DELIVERY_POLL_CEILING_MS = 500;

/** Postgres rejects a NOTIFY payload of 8000 bytes or more. */
const MAX_NOTIFY_PAYLOAD_BYTES = 7_900;
const FANOUT_RECONNECT_DELAY_MS = 5_000;

/** Channel the hub notifies itself on to prove notifications arrive. */
const DELIVERY_PROBE_CHANNEL = "archestra_notify_probe";
const DELIVERY_PROBE_TIMEOUT_MS = 2_000;

/**
 * Hub that never talks to Postgres: waiters are woken only by their own
 * timeout. Used when the database endpoint cannot hold a session-stable
 * listener — PgBouncer in transaction-pooling mode, or a managed proxy that
 * recycles connections — where LISTEN would silently never fire.
 */
export function createPollingNotifyHub(): PgNotifyHub {
  const fanoutHandlers = new FanoutHandlers();
  return {
    fanout: (name) => fanoutHandlers.localChannel(name),
    channel: () => ({
      async notify() {},
      async wait(params) {
        await sleepWithAbort(
          Math.min(params.timeoutMs, UNVERIFIED_DELIVERY_POLL_CEILING_MS),
          params.abortSignal,
        );
      },
    }),
    async close() {},
  };
}

/**
 * Hub confined to this process: waiters are woken by publishes from the same
 * pod, and nothing crosses a replica boundary. Delivery is immediate and
 * always works, so no fallback tightening applies.
 */
export function createInMemoryNotifyHub(): PgNotifyHub {
  const waitersByChannel = new Map<string, KeyWaiters>();
  const fanoutHandlers = new FanoutHandlers();
  const waiters = (name: string) => {
    const existing = waitersByChannel.get(name);
    if (existing) {
      return existing;
    }
    const created = new KeyWaiters();
    waitersByChannel.set(name, created);
    return created;
  };

  return {
    fanout: (name) => fanoutHandlers.localChannel(name),
    channel: (name) => ({
      async notify(key) {
        waiters(name).notify(key);
      },
      async wait(params) {
        await waiters(name).wait(params);
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
  private readonly fanoutHandlers = new FanoutHandlers();
  /** Tags this hub's fan-out messages so it can drop its own echo. */
  private readonly instanceId = randomUUID();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  /** Set once a notification has been observed completing the round trip. */
  private deliveryVerified = false;
  private pendingProbe: {
    token: string;
    resolve: (received: boolean) => void;
  } | null = null;

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
        // Tighten the fallback until a notification has been observed making
        // the full round trip. Behind a transaction pooler LISTEN is accepted
        // and then silently never fires, so "connected" proves nothing — only
        // a delivered notification does.
        const timeoutMs = this.deliveryVerified
          ? params.timeoutMs
          : Math.min(params.timeoutMs, UNVERIFIED_DELIVERY_POLL_CEILING_MS);

        // Register before connecting. `KeyWaiters.wait` enrolls the waiter
        // synchronously, so a notify published during the connect handshake
        // still wakes it instead of being dropped on the floor.
        const waiting = this.waiters(name).wait({ ...params, timeoutMs });

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

  fanout(name: string): FanoutChannel {
    return {
      publish: (message) => this.publishFanout(name, message),
      subscribe: (handler) => {
        const unsubscribe = this.fanoutHandlers.subscribe(name, handler);
        void this.listenForFanout(name);
        return unsubscribe;
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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

  private async publishFanout(channel: string, message: string): Promise<void> {
    // Same-pod subscribers get it directly and synchronously; our own echo
    // from Postgres is dropped by origin below, so nobody sees it twice.
    this.fanoutHandlers.deliver(channel, message);

    const payload = JSON.stringify({ origin: this.instanceId, message });
    if (Buffer.byteLength(payload) > MAX_NOTIFY_PAYLOAD_BYTES) {
      logger.warn(
        { channel, bytes: Buffer.byteLength(payload) },
        "Fan-out message exceeds the NOTIFY payload limit; delivered to this pod only",
      );
      return;
    }

    try {
      await this.ensureConnected();
      await this.client?.query("select pg_notify($1, $2)", [channel, payload]);
    } catch (error) {
      await this.resetClient(this.client);
      logger.warn({ error, channel }, "Failed to publish a fan-out message");
    }
  }

  /**
   * Keyed waiters reconnect on their next wait; a fan-out subscriber has no
   * next call, so it has to keep its LISTEN alive itself.
   */
  private async listenForFanout(channel: string): Promise<void> {
    try {
      await this.ensureConnected();
      // A no-op when the connect above already listened on it.
      await this.client?.query(`LISTEN ${quoteIdentifier(channel)}`);
    } catch (error) {
      logger.warn(
        { error, channel },
        "Failed to listen for fan-out messages; retrying",
      );
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (
      this.closed ||
      this.reconnectTimer ||
      !this.fanoutHandlers.hasSubscribers()
    ) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected().catch(() => this.scheduleReconnect());
    }, FANOUT_RECONNECT_DELAY_MS);
    this.reconnectTimer.unref?.();
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
      if (this.fanoutHandlers.has(channel)) {
        const parsed = parseFanoutMessage(payload);
        if (parsed && parsed.origin !== this.instanceId) {
          this.fanoutHandlers.deliver(channel, parsed.message);
        }
        return;
      }
      const key = parseKey(payload);
      if (!key) {
        return;
      }
      if (channel === DELIVERY_PROBE_CHANNEL) {
        if (this.pendingProbe?.token === key) {
          this.pendingProbe.resolve(true);
        }
        return;
      }
      this.waiters(channel).notify(key);
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
      await client.query(`LISTEN ${quoteIdentifier(DELIVERY_PROBE_CHANNEL)}`);
      for (const channel of [
        ...this.waitersByChannel.keys(),
        ...this.fanoutHandlers.channels(),
      ]) {
        await client.query(`LISTEN ${quoteIdentifier(channel)}`);
      }
      void this.verifyDelivery(client);
    } catch (error) {
      await this.resetClient(client);
      throw error;
    }
  }

  /**
   * Send a notification to ourselves and see whether it comes back.
   *
   * The failure this exists to catch is silent: PgBouncer in transaction
   * pooling accepts `LISTEN`, returns success, and then hands the backend to
   * another client — so the subscription is real but nothing is ever
   * delivered. No error surfaces, and asking the operator to know their pooler
   * topology has been the workaround. Measuring the actual round trip is both
   * more reliable and one less thing to configure.
   *
   * Never throws and never blocks a waiter: until it succeeds the hub simply
   * keeps its fallback tight, which is the same behavior as not having
   * notifications at all.
   */
  private async verifyDelivery(client: PgClient): Promise<void> {
    const token = randomUUID();
    const received = new Promise<boolean>((resolve) => {
      this.pendingProbe = { token, resolve };
      setTimeout(() => resolve(false), DELIVERY_PROBE_TIMEOUT_MS).unref?.();
    });

    try {
      await client.query("select pg_notify($1, $2)", [
        DELIVERY_PROBE_CHANNEL,
        JSON.stringify({ key: token }),
      ]);
    } catch {
      // A publish failure is handled by the normal reconnect path.
      return;
    }

    const verified = await received;
    this.pendingProbe = null;
    if (this.client !== client) {
      return;
    }

    this.deliveryVerified = verified;
    if (!verified) {
      logger.warn(
        "Postgres notifications are not being delivered on this connection (a transaction-pooling endpoint cannot hold a LISTEN). Streams stay correct and fall back to polling; point ARCHESTRA_CHAT_ACTIVE_RUN_NOTIFY_DATABASE_URL at a direct or session-pooled endpoint to restore push wake-ups.",
      );
    }
  }

  private async resetClient(client: PgClient | null): Promise<void> {
    if (!client || this.client !== client) {
      return;
    }

    this.client = null;
    this.connectPromise = null;
    // A new session has to prove itself again.
    this.deliveryVerified = false;
    await client.end().catch((error) => {
      logger.warn({ error }, "Failed to close the Postgres notify connection");
    });
    this.scheduleReconnect();
  }
}

/** Local fan-out subscribers, grouped by channel. */
class FanoutHandlers {
  private readonly handlersByChannel = new Map<
    string,
    Set<(message: string) => void>
  >();

  has(channel: string): boolean {
    return this.handlersByChannel.has(channel);
  }

  hasSubscribers(): boolean {
    return this.handlersByChannel.size > 0;
  }

  channels(): string[] {
    return [...this.handlersByChannel.keys()];
  }

  subscribe(channel: string, handler: (message: string) => void): () => void {
    const handlers = this.handlersByChannel.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlersByChannel.set(channel, handlers);
    return () => {
      handlers.delete(handler);
      if (
        handlers.size === 0 &&
        this.handlersByChannel.get(channel) === handlers
      ) {
        this.handlersByChannel.delete(channel);
      }
    };
  }

  deliver(channel: string, message: string): void {
    for (const handler of this.handlersByChannel.get(channel) ?? []) {
      // Isolate subscribers: one throwing handler must not starve the rest.
      try {
        handler(message);
      } catch (error) {
        logger.warn({ error, channel }, "Fan-out subscriber failed");
      }
    }
  }

  /** A fan-out channel that never leaves this process. */
  localChannel(channel: string): FanoutChannel {
    return {
      publish: async (message) => this.deliver(channel, message),
      subscribe: (handler) => this.subscribe(channel, handler),
    };
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

function parseFanoutMessage(
  payload: string | undefined,
): { origin: string; message: string } | null {
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload);
    return typeof parsed.origin === "string" &&
      typeof parsed.message === "string"
      ? { origin: parsed.origin, message: parsed.message }
      : null;
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
