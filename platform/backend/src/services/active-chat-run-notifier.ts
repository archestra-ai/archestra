import pg from "pg";
import config from "@/config";
import logger from "@/logging";

const EVENT_CHANNEL = "chat_active_run_events";
const STOP_CHANNEL = "chat_active_run_stops";

export interface ActiveChatRunNotifier {
  notifyEvent(runId: string): Promise<void>;
  notifyStop(runId: string): Promise<void>;
  waitForEvent(params: WaitForRunParams): Promise<void>;
  waitForStop(params: WaitForRunParams): Promise<void>;
  close?(): Promise<void>;
}

/**
 * @public - exported for testability
 */
export class PollingActiveChatRunNotifier implements ActiveChatRunNotifier {
  async notifyEvent(_runId: string): Promise<void> {}

  async notifyStop(_runId: string): Promise<void> {}

  async waitForEvent(params: WaitForRunParams): Promise<void> {
    await sleepWithAbort(params.timeoutMs, params.abortSignal);
  }

  async waitForStop(params: WaitForRunParams): Promise<void> {
    await sleepWithAbort(params.timeoutMs, params.abortSignal);
  }
}

/**
 * @public - exported for testability
 */
export class InMemoryActiveChatRunNotifier extends PollingActiveChatRunNotifier {
  private readonly eventWaiters = new RunWaiters();
  private readonly stopWaiters = new RunWaiters();

  async notifyEvent(runId: string): Promise<void> {
    this.eventWaiters.notify(runId);
  }

  async notifyStop(runId: string): Promise<void> {
    this.stopWaiters.notify(runId);
  }

  async waitForEvent(params: WaitForRunParams): Promise<void> {
    await this.eventWaiters.wait(params);
  }

  async waitForStop(params: WaitForRunParams): Promise<void> {
    await this.stopWaiters.wait(params);
  }
}

/**
 * @public - exported for testability
 */
export class PostgresActiveChatRunNotifier extends InMemoryActiveChatRunNotifier {
  private client: PgClient | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly clientFactory: PgClientFactory = createDefaultPgClient,
  ) {
    super();
  }

  override async notifyEvent(runId: string): Promise<void> {
    await this.notify(EVENT_CHANNEL, runId);
  }

  override async notifyStop(runId: string): Promise<void> {
    await this.notify(STOP_CHANNEL, runId);
  }

  override async waitForEvent(params: WaitForRunParams): Promise<void> {
    await this.ensureListening("event", params.runId);
    await super.waitForEvent(params);
  }

  override async waitForStop(params: WaitForRunParams): Promise<void> {
    await this.ensureListening("stop", params.runId);
    await super.waitForStop(params);
  }

  async close(): Promise<void> {
    await this.connectPromise?.catch(() => undefined);
    await this.resetClient(this.client);
  }

  private async notify(channel: string, runId: string): Promise<void> {
    try {
      await this.ensureConnected();
      const client = this.client;
      if (!client) {
        return;
      }

      await client.query("select pg_notify($1, $2)", [
        channel,
        JSON.stringify({ runId }),
      ]);
    } catch (error) {
      await this.resetClient(this.client);
      logger.warn(
        { error, channel, runId },
        "Failed to publish active chat run notification",
      );
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
      this.handleNotification(notification as pg.Notification);
    });
    client.on("error", (error) => {
      logger.warn({ error }, "Active chat run notify connection error");
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
      await client.query(`LISTEN ${EVENT_CHANNEL}`);
      await client.query(`LISTEN ${STOP_CHANNEL}`);
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
      logger.warn({ error }, "Failed to close active chat run notifier");
    });
  }

  private handleNotification(notification: pg.Notification): void {
    const runId = parseRunId(notification.payload);
    if (!runId) {
      return;
    }

    if (notification.channel === EVENT_CHANNEL) {
      void super.notifyEvent(runId);
      return;
    }

    if (notification.channel === STOP_CHANNEL) {
      void super.notifyStop(runId);
    }
  }

  private async ensureListening(kind: "event" | "stop", runId: string) {
    try {
      await this.ensureConnected();
    } catch (error) {
      await this.resetClient(this.client);
      logger.warn(
        { error, kind, runId },
        "Failed to ensure active chat run listener connection",
      );
    }
  }
}

export function createActiveChatRunNotifier(): ActiveChatRunNotifier {
  // Prefer Postgres LISTEN/NOTIFY for active-run replay and Stop wake-ups. Use
  // polling compatibility only when the database endpoint cannot keep a
  // session-stable listener connection, for example PgBouncer transaction
  // pooling or managed/serverless proxies that break long-lived listeners.
  if (config.chat.activeRun.pollingCompatibilityEnabled) {
    return new PollingActiveChatRunNotifier();
  }

  return new PostgresActiveChatRunNotifier(
    config.chat.activeRun.notifyDatabaseUrl || config.database.url,
  );
}

interface WaitForRunParams {
  runId: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

interface PgClient {
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
  query(queryText: string, values?: unknown[]): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

type PgClientFactory = (connectionString: string) => PgClient;

class RunWaiters {
  private readonly waiters = new Map<string, Set<() => void>>();

  notify(runId: string): void {
    const waiters = this.waiters.get(runId);
    if (!waiters) {
      return;
    }

    this.waiters.delete(runId);
    for (const resolve of waiters) {
      resolve();
    }
  }

  async wait(params: WaitForRunParams): Promise<void> {
    if (params.abortSignal?.aborted) {
      return;
    }

    await new Promise<void>((resolve) => {
      const cleanup = () => {
        clearTimeout(timeout);
        params.abortSignal?.removeEventListener("abort", onAbort);
        const waiters = this.waiters.get(params.runId);
        waiters?.delete(resolveAndCleanup);
        if (waiters?.size === 0) {
          this.waiters.delete(params.runId);
        }
      };

      const resolveAndCleanup = () => {
        cleanup();
        resolve();
      };

      const onAbort = () => resolveAndCleanup();
      const timeout = setTimeout(resolveAndCleanup, params.timeoutMs);
      params.abortSignal?.addEventListener("abort", onAbort, { once: true });

      const waiters = this.waiters.get(params.runId) ?? new Set<() => void>();
      waiters.add(resolveAndCleanup);
      this.waiters.set(params.runId, waiters);
    });
  }
}

function parseRunId(payload: string | undefined): string | null {
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload);
    return typeof parsed.runId === "string" ? parsed.runId : null;
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
