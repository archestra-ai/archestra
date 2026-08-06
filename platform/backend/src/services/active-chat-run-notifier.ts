import config from "@/config";
import {
  createInMemoryNotifyHub,
  createPollingNotifyHub,
  createPostgresNotifyHub,
  type KeyedNotifier,
  type PgNotifyHub,
} from "@/services/pg-notify-hub";

/**
 * Cross-replica wake-ups for active chat runs, keyed by run id.
 *
 * Two channels: one for new stream events (so a reconnecting client's replay
 * catches up the moment another pod writes) and one for Stop (so a running
 * stream notices a stop requested on a different pod). Both ride the shared
 * notify hub, which multiplexes every channel in the process onto a single
 * listener connection — A2A task streams use the same one.
 *
 * Delivery is best-effort by design: every wait carries a timeout and re-reads
 * the database, so a missed notification costs latency, never correctness.
 */
const EVENT_CHANNEL = "chat_active_run_events";
const STOP_CHANNEL = "chat_active_run_stops";

export interface ActiveChatRunNotifier {
  notifyEvent(runId: string): Promise<void>;
  notifyStop(runId: string): Promise<void>;
  waitForEvent(params: WaitForRunParams): Promise<void>;
  waitForStop(params: WaitForRunParams): Promise<void>;
  close?(): Promise<void>;
}

interface WaitForRunParams {
  runId: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

/**
 * Adapts a notify hub to the run-id-keyed interface chat uses.
 *
 * Declared above its subclasses rather than at the bottom with the other
 * internals: `extends` is evaluated when the module loads, so the base has to
 * exist by then.
 */
class HubBackedNotifier implements ActiveChatRunNotifier {
  private readonly events: KeyedNotifier;
  private readonly stops: KeyedNotifier;

  constructor(private readonly hub: PgNotifyHub) {
    this.events = hub.channel(EVENT_CHANNEL);
    this.stops = hub.channel(STOP_CHANNEL);
  }

  async notifyEvent(runId: string): Promise<void> {
    await this.events.notify(runId);
  }

  async notifyStop(runId: string): Promise<void> {
    await this.stops.notify(runId);
  }

  async waitForEvent(params: WaitForRunParams): Promise<void> {
    await this.events.wait(toWaitParams(params));
  }

  async waitForStop(params: WaitForRunParams): Promise<void> {
    await this.stops.wait(toWaitParams(params));
  }

  async close(): Promise<void> {
    await this.hub.close();
  }
}

/**
 * @public - exported for testability
 *
 * Wakes waiters in this process only. Real behavior for a single-process test,
 * with no database and no cross-replica delivery.
 */
export class InMemoryActiveChatRunNotifier extends HubBackedNotifier {
  constructor() {
    super(createInMemoryNotifyHub());
  }
}

/**
 * @public - exported for testability
 *
 * Never wakes anything: waiters resolve on their own timeout. Mirrors an
 * endpoint that cannot deliver notifications at all.
 */
export class PollingActiveChatRunNotifier extends HubBackedNotifier {
  constructor() {
    super(createPollingNotifyHub());
  }
}

export function createActiveChatRunNotifier(): ActiveChatRunNotifier {
  // The hub proves for itself whether notifications are delivered and tightens
  // its own fallback when they are not, so this switch only exists to skip
  // opening a listener connection on an endpoint known to be incapable.
  if (config.chat.activeRun.pollingCompatibilityEnabled) {
    return new PollingActiveChatRunNotifier();
  }

  return new HubBackedNotifier(
    createPostgresNotifyHub(
      config.chat.activeRun.notifyDatabaseUrl || config.database.url,
    ),
  );
}

function toWaitParams(params: WaitForRunParams) {
  return {
    key: params.runId,
    timeoutMs: params.timeoutMs,
    abortSignal: params.abortSignal,
  };
}
