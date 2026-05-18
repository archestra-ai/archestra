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

export class PostgresActiveChatRunNotifier extends InMemoryActiveChatRunNotifier {
  private client: pg.Client | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(private readonly connectionString: string) {
    super();
  }

  override async notifyEvent(runId: string): Promise<void> {
    await this.notify(EVENT_CHANNEL, runId);
  }

  override async notifyStop(runId: string): Promise<void> {
    await this.notify(STOP_CHANNEL, runId);
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

  private createClient(): pg.Client {
    const client = new pg.Client({
      connectionString: this.connectionString,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });

    client.on("notification", (notification) => {
      this.handleNotification(notification);
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

  private async connectClient(client: pg.Client): Promise<void> {
    try {
      await client.connect();
      await client.query(`LISTEN ${EVENT_CHANNEL}`);
      await client.query(`LISTEN ${STOP_CHANNEL}`);
    } catch (error) {
      await this.resetClient(client);
      throw error;
    }
  }

  private async resetClient(client: pg.Client | null): Promise<void> {
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
}

export function createActiveChatRunNotifier(): ActiveChatRunNotifier {
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
